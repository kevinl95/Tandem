import json
import time
import unittest

import signaling


class FakeTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item):
        self.items[(Item['pk'], Item['sk'])] = dict(Item)

    def get_item(self, Key):
        item = self.items.get((Key['pk'], Key['sk']))
        return {'Item': dict(item)} if item else {}

    def delete_item(self, Key):
        self.items.pop((Key['pk'], Key['sk']), None)

    def query(self, KeyConditionExpression, ExpressionAttributeValues):
        assert KeyConditionExpression == 'pk = :pk'
        pk = ExpressionAttributeValues[':pk']
        return {'Items': [dict(item) for (item_pk, _), item in self.items.items() if item_pk == pk]}


class GoneException(Exception):
    response = {'Error': {'Code': 'GoneException'}}


class FakeManagementClient:
    def __init__(self):
        self.posts = []
        self.gone = set()

    def post_to_connection(self, ConnectionId, Data):
        if ConnectionId in self.gone:
            raise GoneException()
        self.posts.append((ConnectionId, json.loads(Data)))

    def posts_to(self, connection_id):
        return [payload for target, payload in self.posts if target == connection_id]


def request_context(connection_id, route_key):
    return {
        'connectionId': connection_id,
        'domainName': 'abc.execute-api.us-west-2.amazonaws.com',
        'identity': {'sourceIp': '203.0.113.7'},
        'routeKey': route_key,
        'stage': 'prod',
    }


def connect(connection_id, session_id='K7P2QX', role='receiver'):
    return signaling.handler({
        'requestContext': request_context(connection_id, '$connect'),
        'queryStringParameters': {'sessionId': session_id, 'role': role},
    }, None)


def send(connection_id, message):
    return signaling.handler({
        'requestContext': request_context(connection_id, '$default'),
        'body': json.dumps(message),
    }, None)


def disconnect(connection_id):
    return signaling.handler({'requestContext': request_context(connection_id, '$disconnect')}, None)


class SignalingTest(unittest.TestCase):
    def setUp(self):
        self.table = FakeTable()
        self.client = FakeManagementClient()
        signaling._table = self.table
        signaling._management_clients = {
            'https://abc.execute-api.us-west-2.amazonaws.com/prod': self.client,
        }

    def test_connect_requires_valid_session_and_role(self):
        self.assertEqual(connect('c1', session_id='')['statusCode'], 400)
        self.assertEqual(connect('c1', session_id='bad code!')['statusCode'], 400)
        self.assertEqual(connect('c1', role='admin')['statusCode'], 400)
        self.assertEqual(self.table.items, {})

    def test_connect_normalizes_session_code_and_records_source_ip(self):
        self.assertEqual(connect('c1', session_id=' k7p2qx ')['statusCode'], 200)

        meta = self.table.items[('connection#c1', 'meta')]
        self.assertEqual(meta['sessionId'], 'K7P2QX')
        self.assertEqual(meta['sourceIp'], '203.0.113.7')
        self.assertGreater(meta['expiresAt'], time.time())

    def test_offer_reaches_receiver_and_is_not_echoed_to_sender(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')

        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'SPOOFED', 'role': 'receiver'})

        self.assertEqual(self.client.posts_to('laptop'), [])
        self.assertEqual(self.client.posts_to('tv'), [
            {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX', 'from': 'sender'},
        ])

    def test_ice_from_receiver_only_reaches_senders(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')

        send('tv', {'type': 'ice', 'candidate': None})

        self.assertEqual(self.client.posts_to('tv'), [])
        self.assertEqual(self.client.posts_to('laptop'), [
            {'type': 'ice', 'candidate': None, 'sessionId': 'K7P2QX', 'from': 'receiver'},
        ])

    def test_messages_do_not_cross_sessions(self):
        connect('tv', session_id='AAAA11', role='receiver')
        connect('laptop', session_id='BBBB22', role='sender')

        send('laptop', {'type': 'offer', 'sdp': 'v=0'})

        self.assertEqual(self.client.posts_to('tv'), [])
        self.assertEqual(self.client.posts_to('laptop'), [
            {'type': 'error', 'reason': 'no-peer', 'sessionId': 'BBBB22'},
        ])

    def test_roles_cannot_send_the_other_sides_messages(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')

        self.assertEqual(send('tv', {'type': 'offer', 'sdp': 'v=0'})['statusCode'], 400)
        self.assertEqual(send('laptop', {'type': 'answer', 'sdp': 'v=0'})['statusCode'], 400)
        self.assertEqual(self.client.posts, [])

    def test_ping_is_accepted_without_relaying(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')

        self.assertEqual(send('tv', {'type': 'ping'})['statusCode'], 200)
        self.assertEqual(self.client.posts, [])

    def test_unknown_or_expired_connections_are_rejected(self):
        self.assertEqual(send('ghost', {'type': 'offer', 'sdp': 'v=0'})['statusCode'], 403)

        connect('tv', role='receiver')
        self.table.items[('connection#tv', 'meta')]['expiresAt'] = int(time.time()) - 1
        self.assertEqual(send('tv', {'type': 'ping'})['statusCode'], 403)

    def test_expired_peers_are_skipped(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')
        self.table.items[('session#K7P2QX', 'connection#tv')]['expiresAt'] = int(time.time()) - 1

        send('laptop', {'type': 'offer', 'sdp': 'v=0'})

        self.assertEqual(self.client.posts_to('tv'), [])
        self.assertEqual(self.client.posts_to('laptop')[0]['reason'], 'no-peer')

    def test_invalid_json_is_rejected(self):
        connect('tv', role='receiver')
        response = signaling.handler({
            'requestContext': request_context('tv', '$default'),
            'body': '{not json',
        }, None)
        self.assertEqual(response['statusCode'], 400)

    def test_gone_peers_are_removed(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')
        self.client.gone.add('tv')

        send('laptop', {'type': 'offer', 'sdp': 'v=0'})

        self.assertNotIn(('session#K7P2QX', 'connection#tv'), self.table.items)
        self.assertNotIn(('connection#tv', 'meta'), self.table.items)

    def test_disconnect_cleans_up_and_notifies_peers(self):
        connect('tv', role='receiver')
        connect('laptop', role='sender')

        self.assertEqual(disconnect('laptop')['statusCode'], 200)

        self.assertNotIn(('connection#laptop', 'meta'), self.table.items)
        self.assertNotIn(('session#K7P2QX', 'connection#laptop'), self.table.items)
        self.assertEqual(self.client.posts_to('tv'), [{'type': 'peer-left', 'from': 'sender'}])

    def test_disconnect_of_unknown_connection_is_a_no_op(self):
        self.assertEqual(disconnect('ghost')['statusCode'], 200)


if __name__ == '__main__':
    unittest.main()
