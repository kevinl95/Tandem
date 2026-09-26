"""WebSocket signaling for Tandem.

Relays offers, answers and ICE candidates between the receiver (TV) and the
sender in a session. Media never passes through AWS.

This file is the source of truth for the inline Lambda code in
infra/cloudformation/vega-mirroring.json; run `npm run sync:lambda` after
editing it.
"""
import json
import logging
import os
import re
import time

LOGGER = logging.getLogger()
LOGGER.setLevel(logging.INFO)

# API Gateway closes WebSocket connections after 2 hours, so anything older
# than this is stale even if $disconnect never ran.
CONNECTION_TTL_SECONDS = 3 * 60 * 60
SESSION_ID_PATTERN = re.compile(r'^[A-Z0-9]{4,16}$')
ALLOWED_MESSAGES = {
    'receiver': {'answer', 'ice', 'ping'},
    'sender': {'offer', 'ice', 'ping'},
}

_table = None
_management_clients = {}


def get_table():
    global _table
    if _table is None:
        import boto3

        _table = boto3.resource('dynamodb').Table(os.environ['SESSION_TABLE_NAME'])
    return _table


def get_management_client(domain_name, stage):
    endpoint_url = f'https://{domain_name}/{stage}'
    if endpoint_url not in _management_clients:
        import boto3

        _management_clients[endpoint_url] = boto3.client(
            'apigatewaymanagementapi',
            endpoint_url=endpoint_url,
        )
    return _management_clients[endpoint_url]


def response(status_code, body=''):
    return {'statusCode': status_code, 'body': body}


def get_connection(connection_id):
    item = get_table().get_item(
        Key={'pk': f'connection#{connection_id}', 'sk': 'meta'},
    ).get('Item')
    return item if item and int(item.get('expiresAt', 0)) > time.time() else None


def remove_connection(session_id, connection_id):
    table = get_table()
    table.delete_item(Key={'pk': f'session#{session_id}', 'sk': f'connection#{connection_id}'})
    table.delete_item(Key={'pk': f'connection#{connection_id}', 'sk': 'meta'})


def list_peers(session_id, connection_id, role):
    items = get_table().query(
        KeyConditionExpression='pk = :pk',
        ExpressionAttributeValues={':pk': f'session#{session_id}'},
    ).get('Items', [])
    now = time.time()
    return [
        item
        for item in items
        if item.get('connectionId') != connection_id
        and item.get('role') != role
        and int(item.get('expiresAt', 0)) > now
    ]


def post_to_connection(request_context, session_id, connection_id, payload):
    client = get_management_client(request_context['domainName'], request_context['stage'])
    try:
        client.post_to_connection(
            ConnectionId=connection_id,
            Data=json.dumps(payload).encode('utf-8'),
        )
        return True
    except Exception as error:  # boto3 raises GoneException as a ClientError subclass
        code = getattr(error, 'response', {}).get('Error', {}).get('Code')
        if code == 'GoneException':
            remove_connection(session_id, connection_id)
        else:
            LOGGER.exception('PostToConnection failed for %s', connection_id)
        return False


def on_connect(event, connection_id):
    params = event.get('queryStringParameters') or {}
    session_id = (params.get('sessionId') or '').strip().upper()
    role = params.get('role')

    if not SESSION_ID_PATTERN.match(session_id) or role not in ALLOWED_MESSAGES:
        return response(400, 'a valid sessionId and role (receiver or sender) are required')

    expires_at = int(time.time()) + CONNECTION_TTL_SECONDS
    source_ip = event['requestContext'].get('identity', {}).get('sourceIp', '')
    table = get_table()
    table.put_item(Item={
        'pk': f'session#{session_id}',
        'sk': f'connection#{connection_id}',
        'connectionId': connection_id,
        'role': role,
        'expiresAt': expires_at,
    })
    table.put_item(Item={
        'pk': f'connection#{connection_id}',
        'sk': 'meta',
        'sessionId': session_id,
        'role': role,
        'sourceIp': source_ip,
        'expiresAt': expires_at,
    })
    return response(200)


def on_disconnect(event, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        return response(200)

    session_id = connection['sessionId']
    remove_connection(session_id, connection_id)
    for peer in list_peers(session_id, connection_id, connection['role']):
        post_to_connection(
            event['requestContext'],
            session_id,
            peer['connectionId'],
            {'type': 'peer-left', 'from': connection['role']},
        )
    return response(200)


def on_message(event, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        return response(403, 'unknown connection')

    try:
        message = json.loads(event.get('body') or '{}')
    except json.JSONDecodeError:
        return response(400, 'message must be JSON')

    role = connection['role']
    message_type = message.get('type') if isinstance(message, dict) else None
    if message_type not in ALLOWED_MESSAGES[role]:
        return response(400, f'{role} cannot send {message_type!r}')
    if message_type == 'ping':
        return response(200)

    session_id = connection['sessionId']
    request_context = event['requestContext']
    # Session and role come from the connection record, never from the message.
    payload = {**message, 'sessionId': session_id, 'from': role}
    payload.pop('role', None)

    peers = list_peers(session_id, connection_id, role)
    delivered = sum(
        post_to_connection(request_context, session_id, peer['connectionId'], payload)
        for peer in peers
    )
    if delivered == 0 and message_type in ('offer', 'answer'):
        post_to_connection(
            request_context,
            session_id,
            connection_id,
            {'type': 'error', 'reason': 'no-peer', 'sessionId': session_id},
        )
    return response(200)


def handler(event, _context):
    route_key = event['requestContext']['routeKey']
    connection_id = event['requestContext']['connectionId']

    if route_key == '$connect':
        return on_connect(event, connection_id)
    if route_key == '$disconnect':
        return on_disconnect(event, connection_id)
    return on_message(event, connection_id)
