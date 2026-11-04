'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { APNSMessage, FCMMessage, GCMMessage, createMessage } = require('..');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

describe('APNSMessage', () => {
	it('parses a JSON string and normalizes `token` to an array', () => {
		const message = createMessage('apns', JSON.stringify({ identifier: 'a', token: TOKEN, alert: 'hi' }));
		assert.ok(message instanceof APNSMessage);
		assert.equal(message.platform, 'apns');
		assert.equal(message.identifier, 'a');
		assert.deepEqual(message.token, [ TOKEN ]);
		assert.equal(message.alert, 'hi');
	});

	it('accepts a plain object and a Buffer', () => {
		assert.deepEqual(createMessage('apns', { token: [ 'aa', 'BB' ] }).token, [ 'aa', 'BB' ]);
		assert.deepEqual(createMessage('apns', Buffer.from('{"token":"ff"}')).token, [ 'ff' ]);
	});

	it('only accepts hex tokens, since they go into the request path', () => {
		for (const token of [ undefined, '', [], [ 'aa', 1 ], [ 'aa', '' ], 123, 'not-hex', '../x', 'aa/bb' ])
			assert.throws(() => createMessage('apns', { token }), /`token` must be/, JSON.stringify(token));
	});

	it('throws SyntaxError on invalid JSON and TypeError on non-objects', () => {
		assert.throws(() => createMessage('apns', '{oops'), SyntaxError);
		for (const data of [ 42, null, undefined, [ 'a' ], true ])
			assert.throws(() => new APNSMessage(data), TypeError, String(data));
	});

	it('rejects an identifier that is not a string or number', () => {
		assert.throws(() => createMessage('apns', { token: 'aa', identifier: {} }), /`identifier`/);
		assert.doesNotThrow(() => createMessage('apns', { token: 'aa', identifier: 7 }));
	});

	describe('request()', () => {
		it('builds the path, headers and body', () => {
			const message = createMessage('apns', {
				token: TOKEN, alert: { title: 'T', body: 'B' }, badge: 0, sound: 'default',
				category: 'cat', threadId: 'thread', mutableContent: true,
				payload: { custom: 1 }, aps: { 'interruption-level': 'time-sensitive' }, collapseId: 'c'
			});
			const request = message.request(TOKEN, { topic: 'com.example.app' });
			assert.equal(request.path, '/3/device/' + TOKEN);
			assert.deepEqual(request.headers, {
				'apns-push-type': 'alert',
				'apns-priority': '10',
				'apns-topic': 'com.example.app',
				'apns-collapse-id': 'c'
			});
			assert.deepEqual(JSON.parse(request.body), {
				custom: 1,
				aps: {
					'interruption-level': 'time-sensitive',
					alert: { title: 'T', body: 'B' }, badge: 0, sound: 'default',
					category: 'cat', 'thread-id': 'thread', 'mutable-content': 1
				}
			});
		});

		it('uses the background push type and priority 5 for silent pushes', () => {
			const request = createMessage('apns', { token: 'aa', contentAvailable: true }).request('aa');
			assert.equal(request.headers['apns-push-type'], 'background');
			assert.equal(request.headers['apns-priority'], '5');
			assert.deepEqual(JSON.parse(request.body), { aps: { 'content-available': 1 } });
		});

		it('lets the message override topic, push type and priority', () => {
			const message = createMessage('apns', { token: 'aa', alert: 'x', topic: 'com.other.voip', pushType: 'voip', priority: 5 });
			const { headers } = message.request('aa', { topic: 'com.example.app' });
			assert.equal(headers['apns-topic'], 'com.other.voip');
			assert.equal(headers['apns-push-type'], 'voip');
			assert.equal(headers['apns-priority'], '5');
		});

		it('converts `expiry` from seconds-from-now to a timestamp, and keeps 0', () => {
			const now = Math.floor(Date.now() / 1000);
			const expiration = Number(createMessage('apns', { token: 'aa', expiry: 60 }).request('aa').headers['apns-expiration']);
			assert.ok(expiration >= now + 60 && expiration <= now + 61, 'expiration=' + expiration);
			assert.equal(createMessage('apns', { token: 'aa', expiry: 0 }).request('aa').headers['apns-expiration'], '0');
			assert.ok(!('apns-expiration' in createMessage('apns', { token: 'aa' }).request('aa').headers));
		});
	});

	it('rejects payloads over 4 KB', () => {
		assert.throws(() => createMessage('apns', { token: 'aa', alert: 'x'.repeat(4100) }), /payload is \d+ bytes, the limit is 4096/);
	});

	it('rejects an invalid priority', () => {
		assert.throws(() => createMessage('apns', { token: 'aa', priority: 7 }), /`priority`/);
	});
});

describe('FCMMessage', () => {
	it('parses and normalizes `token` to an array', () => {
		const message = createMessage('fcm', '{"identifier":"g","token":"t1"}');
		assert.ok(message instanceof FCMMessage);
		assert.equal(message.platform, 'fcm');
		assert.deepEqual(message.token, [ 't1' ]);
	});

	it('accepts the legacy GCM `registrationId` field and `gcm` platform name', () => {
		const message = createMessage('gcm', { registrationId: [ 'r1', 'r2' ] });
		assert.ok(message instanceof FCMMessage);
		assert.strictEqual(GCMMessage, FCMMessage);
		assert.deepEqual(message.token, [ 'r1', 'r2' ]);
	});

	it('builds an FCM v1 request, JSON-encoding non-string data values', () => {
		const message = createMessage('fcm', {
			token: 't', notification: { title: 'T', body: 'B' },
			data: { s: 'x', n: 1, b: true, o: { a: 1 } },
			collapseKey: 'status', timeToLive: 300, priority: 'high',
			android: { notification: { channel_id: 'news' } },
			apns: { headers: { 'apns-priority': '5' } }, webpush: { headers: {} }, fcmOptions: { analytics_label: 'l' },
			delayWhileIdle: true // Legacy GCM field, ignored.
		});
		assert.deepEqual(message.request('t'), {
			message: {
				token: 't',
				notification: { title: 'T', body: 'B' },
				data: { s: 'x', n: '1', b: 'true', o: '{"a":1}' },
				android: { notification: { channel_id: 'news' }, collapse_key: 'status', ttl: '300s', priority: 'HIGH' },
				apns: { headers: { 'apns-priority': '5' } },
				webpush: { headers: {} },
				fcm_options: { analytics_label: 'l' }
			}
		});
	});

	it('sends only the token when nothing else is set', () => {
		assert.deepEqual(createMessage('fcm', { token: 't' }).request('t'), { message: { token: 't' } });
	});

	it('keeps `timeToLive: 0`', () => {
		assert.equal(createMessage('fcm', { token: 't', timeToLive: 0 }).request('t').message.android.ttl, '0s');
	});

	it('rejects invalid fields', () => {
		for (const token of [ undefined, '', [], [ 'a', null ], [ ' ' ] ])
			assert.throws(() => createMessage('fcm', { token }), /`token`/);
		assert.throws(() => createMessage('fcm', { token: 't', timeToLive: 2419201 }), /`timeToLive`/);
		assert.throws(() => createMessage('fcm', { token: 't', priority: 'urgent' }), /`priority`/);
		assert.throws(() => createMessage('fcm', { token: 't', data: 'x' }), /`data` must be an object/);
		assert.throws(() => createMessage('fcm', { token: 't', notification: [] }), /`notification` must be an object/);
	});
});

describe('createMessage', () => {
	it('throws on an unknown platform', () => {
		assert.throws(() => createMessage('mpns', { token: 't' }), /Unknown platform: mpns/);
	});
});
