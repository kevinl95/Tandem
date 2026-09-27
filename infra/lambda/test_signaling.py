import json
import time
import unittest

import signaling


class FakeTable:
    def __init__(self):
        self.items = {}

    def put_item(self, Item, ConditionExpression=None, ExpressionAttributeValues=None):
        key = (Item['pk'], Item['sk'])
        if ConditionExpression is not None:
            assert ConditionExpression == 'attribute_not_exists(pk) OR secretHash = :hash OR expiresAt < :now'
            existing = self.items.get(key)
            if existing and existing['secretHash'] != ExpressionAttributeValues[':hash'] \
                    and existing['expiresAt'] >= ExpressionAttributeValues[':now']:
                raise ConditionalCheckFailed()
        self.items[key] = dict(Item)

    def get_item(self, Key):
        item = self.items.get((Key['pk'], Key['sk']))
        return {'Item': dict(item)} if item else {}

    def delete_item(self, Key):
        self.items.pop((Key['pk'], Key['sk']), None)

    def query(self, KeyConditionExpression, ExpressionAttributeValues):
        assert KeyConditionExpression == 'pk = :pk'
        pk = ExpressionAttributeValues[':pk']
        return {'Items': [dict(item) for (item_pk, _), item in self.items.items() if item_pk == pk]}

    def update_item(self, Key, UpdateExpression, ExpressionAttributeValues, ReturnValues):
        assert UpdateExpression == 'ADD attempts :one SET expiresAt = :expires'
        item = self.items.setdefault((Key['pk'], Key['sk']), {**Key, 'attempts': 0})
        item['attempts'] += ExpressionAttributeValues[':one']
        item['expiresAt'] = ExpressionAttributeValues[':expires']
        return {'Attributes': {'attempts': item['attempts']}}


class ConditionalCheckFailed(Exception):
    response = {'Error': {'Code': 'ConditionalCheckFailedException'}}


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


HOME_IP = '203.0.113.7'
OTHER_IP = '198.51.100.9'


def request_context(connection_id, route_key, source_ip=HOME_IP):
    return {
        'connectionId': connection_id,
        'domainName': 'abc.execute-api.us-west-2.amazonaws.com',
        'identity': {'sourceIp': source_ip},
        'routeKey': route_key,
        'stage': 'prod',
    }


def connect(connection_id, source_ip=HOME_IP, **params):
    return signaling.handler({
        'requestContext': request_context(connection_id, '$connect', source_ip),
        'queryStringParameters': params,
    }, None)


TV_SECRET = 'tv-secret-0123456789abcdefghijklmnop'


def connect_tv(connection_id='tv', session_id='K7P2QX', name='Living Room', source_ip=HOME_IP,
               secret=TV_SECRET):
    return connect(connection_id, source_ip, role='receiver', sessionId=session_id, name=name,
                   receiverSecret=secret)


def connect_sender(connection_id='laptop', client_id='client-laptop-1', name="Kevin's laptop",
                   source_ip=HOME_IP):
    return connect(connection_id, source_ip, role='sender', clientId=client_id, name=name)


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

    # Connecting

    def test_connect_validates_role_session_and_client_id(self):
        self.assertEqual(connect('c1', role='admin')['statusCode'], 400)
        self.assertEqual(connect_tv(session_id='bad code!')['statusCode'], 400)
        self.assertEqual(connect_sender(client_id='short')['statusCode'], 400)
        self.assertEqual(connect_tv(secret='too-short')['statusCode'], 400)
        self.assertEqual(self.table.items, {})

    def test_a_code_belongs_to_the_tv_that_claimed_it(self):
        self.assertEqual(connect_tv('tv')['statusCode'], 200)

        impostor = connect_tv('impostor', secret='impostor-secret-0123456789abcdefghij')

        self.assertEqual(impostor['statusCode'], 403)
        self.assertNotIn(('connection#impostor', 'meta'), self.table.items)
        self.assertNotIn(('session#K7P2QX', 'connection#impostor'), self.table.items)

    def test_the_owning_tv_can_reconnect_with_its_code(self):
        connect_tv('tv')
        disconnect('tv')

        self.assertEqual(connect_tv('tv-again')['statusCode'], 200)
        self.assertNotIn(TV_SECRET, json.dumps(self.table.items[('code#K7P2QX', 'claim')]))

    def test_an_abandoned_code_can_be_claimed_again(self):
        connect_tv('tv')
        self.table.items[('code#K7P2QX', 'claim')]['expiresAt'] = int(time.time()) - 1

        self.assertEqual(connect_tv('new-tv', secret='new-tv-secret-0123456789abcdefghijk')['statusCode'], 200)

    def test_receiver_is_listed_for_discovery_under_its_public_ip(self):
        self.assertEqual(connect_tv(session_id=' k7p-2qx ')['statusCode'], 200)

        listing = self.table.items[(f'ip#{HOME_IP}', 'receiver#tv')]
        self.assertEqual(listing['sessionId'], 'K7P2QX')
        self.assertEqual(listing['name'], 'Living Room')
        self.assertGreater(listing['expiresAt'], time.time())

    def test_names_are_cleaned_and_defaulted(self):
        connect_tv(name='  Den\x00 TV' + 'x' * 60)
        connect_tv('tv2', session_id='AAAA22', name='')

        self.assertEqual(self.table.items[(f'ip#{HOME_IP}', 'receiver#tv')]['name'], ('Den TV' + 'x' * 60)[:40])
        self.assertEqual(self.table.items[(f'ip#{HOME_IP}', 'receiver#tv2')]['name'], 'TV AAAA22')

    # Discovery

    def test_discover_lists_only_live_tvs_on_the_same_network(self):
        connect_tv('tv1', session_id='AAAA11', name='Bedroom')
        connect_tv('tv2', session_id='BBBB22', name='Attic')
        connect_tv('tv3', session_id='CCCC33', name='Neighbor', source_ip=OTHER_IP)
        connect_tv('tv4', session_id='DDDD44', name='Stale')
        self.table.items[(f'ip#{HOME_IP}', 'receiver#tv4')]['expiresAt'] = int(time.time()) - 1
        connect_sender()

        send('laptop', {'type': 'discover'})

        self.assertEqual(self.client.posts_to('laptop'), [{
            'type': 'receivers',
            'receivers': [
                {'sessionId': 'BBBB22', 'name': 'Attic'},
                {'sessionId': 'AAAA11', 'name': 'Bedroom'},
            ],
        }])

    def test_receivers_cannot_discover(self):
        connect_tv()
        self.assertEqual(send('tv', {'type': 'discover'})['statusCode'], 400)

    # Offers

    def test_offer_reaches_the_tv_with_server_verified_sender_identity(self):
        connect_tv()
        connect_sender()

        send('laptop', {
            'type': 'offer', 'sdp': 'v=0', 'sessionId': 'k7p2qx',
            'senderName': 'Spoofed', 'clientId': 'spoofed-client', 'senderId': 'spoofed',
        })

        self.assertEqual(self.client.posts_to('laptop'), [])
        self.assertEqual(self.client.posts_to('tv'), [{
            'type': 'offer',
            'sdp': 'v=0',
            'sessionId': 'K7P2QX',
            'senderId': 'laptop',
            'senderName': "Kevin's laptop",
            'clientId': 'client-laptop-1',
            'sameNetwork': True,
        }])

    def test_offer_from_another_network_is_flagged(self):
        connect_tv()
        connect_sender(source_ip=OTHER_IP)

        signaling.handler({
            'requestContext': request_context('laptop', '$default', OTHER_IP),
            'body': json.dumps({'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'}),
        }, None)

        self.assertIs(self.client.posts_to('tv')[0]['sameNetwork'], False)

    def test_offer_to_unknown_code_reports_no_peer(self):
        connect_sender()

        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'ZZZZ99'})

        self.assertEqual(self.client.posts_to('laptop'), [
            {'type': 'error', 'reason': 'no-peer', 'sessionId': 'ZZZZ99'},
        ])

    def test_repeated_wrong_codes_are_rate_limited_per_ip(self):
        connect_tv()
        connect_sender()
        for attempt in range(signaling.MAX_FAILED_CODE_ATTEMPTS):
            send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': f'WRONG{attempt}'})

        result = send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        self.assertEqual(result['statusCode'], 429)
        self.assertEqual(self.client.posts_to('tv'), [])
        self.assertEqual(self.client.posts_to('laptop')[-1]['reason'], 'rate-limited')

    def test_offer_rebinds_the_sender_to_a_new_tv(self):
        connect_tv('tv1', session_id='AAAA11')
        connect_tv('tv2', session_id='BBBB22')
        connect_sender()

        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'AAAA11'})
        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'BBBB22'})

        self.assertNotIn(('session#AAAA11', 'connection#laptop'), self.table.items)
        self.assertIn(('session#BBBB22', 'connection#laptop'), self.table.items)
        self.assertEqual(self.table.items[('connection#laptop', 'meta')]['sessionId'], 'BBBB22')

    # Session messages

    def test_sender_ice_before_offer_is_rejected(self):
        connect_sender()
        self.assertEqual(send('laptop', {'type': 'ice', 'candidate': None})['statusCode'], 400)

    def test_sender_ice_reaches_the_tv_tagged_with_the_sender(self):
        connect_tv()
        connect_sender()
        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        send('laptop', {'type': 'ice', 'candidate': None})

        self.assertEqual(self.client.posts_to('tv')[-1], {
            'type': 'ice', 'candidate': None, 'sessionId': 'K7P2QX', 'from': 'sender', 'senderId': 'laptop',
        })

    def test_tv_replies_reach_only_the_named_sender(self):
        connect_tv()
        connect_sender('laptop', client_id='client-laptop-1')
        connect_sender('desktop', client_id='client-desktop-1')
        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})
        send('desktop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        send('tv', {'type': 'answer', 'sdp': 'answer', 'to': 'laptop'})
        send('tv', {'type': 'pending', 'to': 'desktop'})
        send('tv', {'type': 'decline', 'to': 'desktop'})
        send('tv', {'type': 'ice', 'candidate': None})

        self.assertEqual(self.client.posts_to('laptop'), [
            {'type': 'answer', 'sdp': 'answer', 'sessionId': 'K7P2QX', 'from': 'receiver'},
        ])
        self.assertEqual(self.client.posts_to('desktop'), [
            {'type': 'pending', 'sessionId': 'K7P2QX', 'from': 'receiver'},
            {'type': 'decline', 'sessionId': 'K7P2QX', 'from': 'receiver'},
        ])

    def test_roles_cannot_send_the_other_sides_messages(self):
        connect_tv()
        connect_sender()

        self.assertEqual(send('tv', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})['statusCode'], 400)
        self.assertEqual(send('laptop', {'type': 'answer', 'sdp': 'v=0'})['statusCode'], 400)
        self.assertEqual(send('laptop', {'type': 'decline'})['statusCode'], 400)
        self.assertEqual(self.client.posts, [])

    def test_ping_is_accepted_without_relaying(self):
        connect_tv()
        self.assertEqual(send('tv', {'type': 'ping'})['statusCode'], 200)
        self.assertEqual(self.client.posts, [])

    def test_unknown_or_expired_connections_are_rejected(self):
        self.assertEqual(send('ghost', {'type': 'discover'})['statusCode'], 403)

        connect_tv()
        self.table.items[('connection#tv', 'meta')]['expiresAt'] = int(time.time()) - 1
        self.assertEqual(send('tv', {'type': 'ping'})['statusCode'], 403)

    def test_invalid_json_is_rejected(self):
        connect_tv()
        result = signaling.handler({
            'requestContext': request_context('tv', '$default'),
            'body': '{not json',
        }, None)
        self.assertEqual(result['statusCode'], 400)

    # Cleanup

    def test_gone_tv_is_removed_everywhere(self):
        connect_tv()
        connect_sender()
        self.client.gone.add('tv')

        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        self.assertEqual(
            [key for key in self.table.items if 'tv' in key[0] + key[1]],
            [],
        )

    def test_sender_disconnect_notifies_the_tv_which_sender_left(self):
        connect_tv()
        connect_sender()
        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        self.assertEqual(disconnect('laptop')['statusCode'], 200)

        self.assertNotIn(('connection#laptop', 'meta'), self.table.items)
        self.assertNotIn(('session#K7P2QX', 'connection#laptop'), self.table.items)
        self.assertEqual(self.client.posts_to('tv')[-1], {
            'type': 'peer-left', 'from': 'sender', 'sessionId': 'K7P2QX', 'senderId': 'laptop',
        })

    def test_tv_disconnect_removes_its_listing_and_notifies_senders(self):
        connect_tv()
        connect_sender()
        send('laptop', {'type': 'offer', 'sdp': 'v=0', 'sessionId': 'K7P2QX'})

        disconnect('tv')

        self.assertNotIn((f'ip#{HOME_IP}', 'receiver#tv'), self.table.items)
        self.assertEqual(self.client.posts_to('laptop'), [
            {'type': 'peer-left', 'from': 'receiver', 'sessionId': 'K7P2QX'},
        ])

    def test_unbound_sender_disconnect_notifies_nobody(self):
        connect_tv()
        connect_sender()

        disconnect('laptop')

        self.assertEqual(self.client.posts, [])

    def test_disconnect_of_unknown_connection_is_a_no_op(self):
        self.assertEqual(disconnect('ghost')['statusCode'], 200)


if __name__ == '__main__':
    unittest.main()
