"""WebSocket signaling for Tandem.

Relays offers, answers and ICE candidates between a receiver (TV) and the
senders that want to share to it. Media never passes through AWS.

Receivers join with their pairing code and a display name, and are listed for
discovery under their public IP, so senders on the same network can find them
without typing the code. Senders connect without a session and bind to one by
sending an offer to its code. The TV decides whether to accept each sender.

This file is the source of truth for the inline Lambda code in
infra/cloudformation/vega-mirroring.json; run `npm run sync:lambda` after
editing it.
"""
import hashlib
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
CLIENT_ID_PATTERN = re.compile(r'^[A-Za-z0-9-]{8,64}$')
RECEIVER_SECRET_PATTERN = re.compile(r'^[A-Za-z0-9_-]{32,128}$')
# A TV keeps its code while it reconnects at least this often; after that the
# code can be claimed by another TV.
CODE_CLAIM_TTL_SECONDS = 90 * 24 * 60 * 60
MAX_NAME_LENGTH = 40
# Per source IP and window: offers to codes with no TV behind them (guessing),
# and offers of any kind (spamming a TV with prompts). A household sharing a
# public IP stays far below both.
RATE_WINDOW_SECONDS = 10 * 60
MAX_FAILED_CODE_ATTEMPTS = 10
MAX_OFFERS = 30
ALLOWED_MESSAGES = {
    'receiver': {'answer', 'decline', 'ice', 'pending', 'ping'},
    'sender': {'discover', 'offer', 'ice', 'ping'},
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
    # Messages to clients must go through the API's own execute-api endpoint.
    # With a custom domain, the request context names that domain instead,
    # and callbacks through it are denied, so the stack passes the endpoint in.
    endpoint_url = os.environ.get('CALLBACK_URL') or f'https://{domain_name}/{stage}'
    if endpoint_url not in _management_clients:
        import boto3

        _management_clients[endpoint_url] = boto3.client(
            'apigatewaymanagementapi',
            endpoint_url=endpoint_url,
        )
    return _management_clients[endpoint_url]


def response(status_code, body=''):
    return {'statusCode': status_code, 'body': body}


def normalize_session_id(value):
    return re.sub(r'[\s-]', '', str(value or '')).upper()


def clean_name(value, fallback):
    name = re.sub(r'[\x00-\x1f\x7f]', '', str(value or '')).strip()
    return name[:MAX_NAME_LENGTH] or fallback


def is_live(item, now=None):
    return int(item.get('expiresAt', 0)) > (now or time.time())


def session_key(session_id, connection_id):
    return {'pk': f'session#{session_id}', 'sk': f'connection#{connection_id}'}


def meta_key(connection_id):
    return {'pk': f'connection#{connection_id}', 'sk': 'meta'}


def discovery_key(source_ip, connection_id):
    return {'pk': f'ip#{source_ip}', 'sk': f'receiver#{connection_id}'}


def claim_code(session_id, secret):
    """Claims a pairing code for the TV holding secret. Returns False if
    another TV holds it, so nobody can impersonate a TV by reusing its code."""
    secret_hash = hashlib.sha256(secret.encode('utf-8')).hexdigest()
    try:
        get_table().put_item(
            Item={
                'pk': f'code#{session_id}',
                'sk': 'claim',
                'secretHash': secret_hash,
                'expiresAt': int(time.time()) + CODE_CLAIM_TTL_SECONDS,
            },
            ConditionExpression='attribute_not_exists(pk) OR secretHash = :hash OR expiresAt < :now',
            ExpressionAttributeValues={':hash': secret_hash, ':now': int(time.time())},
        )
        return True
    except Exception as error:  # boto3 raises ConditionalCheckFailedException
        code = getattr(error, 'response', {}).get('Error', {}).get('Code')
        if code == 'ConditionalCheckFailedException':
            return False
        raise


def get_connection(connection_id):
    item = get_table().get_item(Key=meta_key(connection_id)).get('Item')
    return item if item and is_live(item) else None


def query_partition(pk):
    items = get_table().query(
        KeyConditionExpression='pk = :pk',
        ExpressionAttributeValues={':pk': pk},
    ).get('Items', [])
    now = time.time()
    return [item for item in items if is_live(item, now)]


def remove_connection(connection_id, connection=None):
    connection = connection or get_table().get_item(Key=meta_key(connection_id)).get('Item') or {}
    table = get_table()
    if connection.get('sessionId'):
        table.delete_item(Key=session_key(connection['sessionId'], connection_id))
    if connection.get('role') == 'receiver' and connection.get('sourceIp'):
        table.delete_item(Key=discovery_key(connection['sourceIp'], connection_id))
    table.delete_item(Key=meta_key(connection_id))


def session_members(session_id, role):
    return [item for item in query_partition(f'session#{session_id}') if item.get('role') == role]


def post_to_connection(request_context, connection_id, payload):
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
            remove_connection(connection_id)
        else:
            LOGGER.exception('PostToConnection failed for %s', connection_id)
        return False


def rate_key(kind, source_ip):
    window = int(time.time()) // RATE_WINDOW_SECONDS
    return {'pk': f'rate#{source_ip}', 'sk': f'{kind}#{window}'}, (window + 1) * RATE_WINDOW_SECONDS


def count_event(kind, source_ip):
    """Counts one event of kind for source_ip; returns the count in this window."""
    key, expires_at = rate_key(kind, source_ip)
    result = get_table().update_item(
        Key=key,
        UpdateExpression='ADD attempts :one SET expiresAt = :expires',
        ExpressionAttributeValues={':one': 1, ':expires': expires_at},
        ReturnValues='UPDATED_NEW',
    )
    return int(result['Attributes']['attempts'])


def event_count(kind, source_ip):
    key, _ = rate_key(kind, source_ip)
    item = get_table().get_item(Key=key).get('Item')
    return int(item.get('attempts', 0)) if item else 0


def on_connect(event, connection_id):
    params = event.get('queryStringParameters') or {}
    role = params.get('role')
    source_ip = event['requestContext'].get('identity', {}).get('sourceIp', '')
    expires_at = int(time.time()) + CONNECTION_TTL_SECONDS
    table = get_table()

    if role == 'receiver':
        session_id = normalize_session_id(params.get('sessionId'))
        secret = params.get('receiverSecret') or ''
        if not SESSION_ID_PATTERN.match(session_id) or not RECEIVER_SECRET_PATTERN.match(secret):
            return response(400, 'receivers need a valid sessionId and receiverSecret')
        if not claim_code(session_id, secret):
            LOGGER.warning('Rejected receiver for code %s: secret mismatch', session_id)
            return response(403, 'this code belongs to another TV')

        name = clean_name(params.get('name'), f'TV {session_id}')
        table.put_item(Item={
            **session_key(session_id, connection_id),
            'connectionId': connection_id,
            'role': role,
            'sourceIp': source_ip,
            'expiresAt': expires_at,
        })
        table.put_item(Item={
            **discovery_key(source_ip, connection_id),
            'connectionId': connection_id,
            'sessionId': session_id,
            'name': name,
            'expiresAt': expires_at,
        })
        table.put_item(Item={
            **meta_key(connection_id),
            'role': role,
            'sessionId': session_id,
            'name': name,
            'sourceIp': source_ip,
            'expiresAt': expires_at,
        })
        return response(200)

    if role == 'sender':
        client_id = params.get('clientId') or ''
        if not CLIENT_ID_PATTERN.match(client_id):
            return response(400, 'senders need a valid clientId')

        table.put_item(Item={
            **meta_key(connection_id),
            'role': role,
            'clientId': client_id,
            'name': clean_name(params.get('name'), 'A device'),
            'sourceIp': source_ip,
            'expiresAt': expires_at,
        })
        return response(200)

    return response(400, 'role must be receiver or sender')


def on_disconnect(event, connection_id):
    connection = get_connection(connection_id)
    if not connection:
        return response(200)

    remove_connection(connection_id, connection)
    session_id = connection.get('sessionId')
    if not session_id:
        return response(200)

    role = connection['role']
    payload = {'type': 'peer-left', 'from': role, 'sessionId': session_id}
    if role == 'sender':
        payload['senderId'] = connection_id
    other_role = 'sender' if role == 'receiver' else 'receiver'
    for peer in session_members(session_id, other_role):
        post_to_connection(event['requestContext'], peer['connectionId'], payload)
    return response(200)


def handle_discover(request_context, connection_id, connection):
    receivers = [
        {'sessionId': item['sessionId'], 'name': item.get('name', item['sessionId'])}
        for item in query_partition(f'ip#{connection["sourceIp"]}')
    ]
    receivers.sort(key=lambda receiver: receiver['name'].lower())
    post_to_connection(request_context, connection_id, {'type': 'receivers', 'receivers': receivers})
    return response(200)


def handle_offer(request_context, connection_id, connection, message):
    source_ip = connection['sourceIp']
    session_id = normalize_session_id(message.get('sessionId'))
    if not SESSION_ID_PATTERN.match(session_id):
        return response(400, 'offer needs a valid sessionId')

    if (event_count('wrong-code', source_ip) >= MAX_FAILED_CODE_ATTEMPTS
            or count_event('offer', source_ip) > MAX_OFFERS):
        post_to_connection(request_context, connection_id, {
            'type': 'error', 'reason': 'rate-limited', 'sessionId': session_id,
        })
        return response(429)

    receivers = session_members(session_id, 'receiver')
    if not receivers:
        count_event('wrong-code', source_ip)
        post_to_connection(request_context, connection_id, {
            'type': 'error', 'reason': 'no-peer', 'sessionId': session_id,
        })
        return response(200)

    # Bind the sender to this session so answers, ICE and departures reach it.
    table = get_table()
    if connection.get('sessionId') and connection['sessionId'] != session_id:
        table.delete_item(Key=session_key(connection['sessionId'], connection_id))
    table.put_item(Item={
        **session_key(session_id, connection_id),
        'connectionId': connection_id,
        'role': 'sender',
        'sourceIp': source_ip,
        'expiresAt': int(connection['expiresAt']),
    })
    table.put_item(Item={**connection, 'sessionId': session_id})

    for receiver in receivers:
        post_to_connection(request_context, receiver['connectionId'], {
            'type': 'offer',
            'sdp': message.get('sdp', ''),
            'sessionId': session_id,
            'senderId': connection_id,
            'senderName': connection['name'],
            'clientId': connection['clientId'],
            'sameNetwork': receiver.get('sourceIp') == source_ip,
        })
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

    request_context = event['requestContext']
    if message_type == 'discover':
        return handle_discover(request_context, connection_id, connection)
    if message_type == 'offer':
        return handle_offer(request_context, connection_id, connection, message)

    session_id = connection.get('sessionId')
    if not session_id:
        return response(400, 'send an offer before other session messages')

    # Session and identity come from the connection records, never the message.
    payload = {**message, 'sessionId': session_id, 'from': role}
    payload.pop('to', None)
    if role == 'sender':
        payload['senderId'] = connection_id
        targets = session_members(session_id, 'receiver')
    else:
        # The TV answers one sender at a time; it must name which.
        target_id = message.get('to')
        targets = [
            member for member in session_members(session_id, 'sender')
            if member['connectionId'] == target_id
        ]

    for target in targets:
        post_to_connection(request_context, target['connectionId'], payload)
    return response(200)


def handler(event, _context):
    route_key = event['requestContext']['routeKey']
    connection_id = event['requestContext']['connectionId']

    if route_key == '$connect':
        return on_connect(event, connection_id)
    if route_key == '$disconnect':
        return on_disconnect(event, connection_id)
    return on_message(event, connection_id)
