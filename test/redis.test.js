'use strict';
//
// End-to-end tests: messages published on a real redis-server (spawned on a
// free port, or $REDIS_PORT) are delivered to the mock APNS/FCM servers.
// Skipped when redis-server is not installed.
//

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');
const { eventually, startRedis, redisAvailable, start, stop, command } = require('./helpers');
const { generateCredentials, startMockAPNS, startMockFCM, apnsOptions, fcmOptions } = require('./mocks');

const credentials = generateCredentials();

describe('with Redis', { skip: !redisAvailable && 'redis-server is not installed', timeout: 30000 }, () => {
	let server, publisher, apns, fcm;
	const pushers = [];

	function createPusher(redisOptions) {
		const pusher = RedisPusher({
			apns: apnsOptions(credentials, apns),
			fcm: fcmOptions(credentials, fcm),
			redis: Object.assign({
				port: server.port,
				channels: { 'test:ios': 'apns', 'test:android': 'fcm' },
				lock: { keyPrefix: 'test_lock_' }
			}, redisOptions)
		});
		pusher.events = [];
		for (const name of [ 'ready', 'message', 'invalid', 'sent', 'unregistered', 'error' ])
			pusher.on(name, (...args) => pusher.events.push([ name, ...args ]));
		pushers.push(pusher);
		return pusher;
	}

	const eventsNamed = (pusher, name) => pusher.events.filter(([ event ]) => event === name);
	const publish = (channel, message) =>
		command(publisher, 'publish', channel, typeof message === 'string' ? message : JSON.stringify(message));
	const lockKeys = () => command(publisher, 'keys', 'test_lock_*');

	before(async () => {
		server = await startRedis();
		publisher = server.client();
		[ apns, fcm ] = await Promise.all([ startMockAPNS(credentials.apns), startMockFCM(credentials.fcm) ]);
	});

	after(async () => {
		await new Promise((resolve) => publisher.quit(resolve));
		await Promise.all([ server.stop(), apns.close(), fcm.close() ]);
	});

	beforeEach(async () => {
		apns.requests.length = 0;
		fcm.requests.length = 0;
		apns.respond = () => ({ status: 200 });
		fcm.respond = () => ({ status: 200 });
		await command(publisher, 'flushdb');
	});

	afterEach(async () => {
		await Promise.all(pushers.splice(0).map(stop));
	});

	it('emits `ready` and calls back once subscribed to every channel', async () => {
		const pusher = createPusher();
		await start(pusher);
		assert.deepEqual(pusher.events, [ [ 'ready' ] ]);
		assert.equal(pusher.running, true);

		const subscribers = await command(publisher, 'pubsub', 'numsub', 'test:ios', 'test:android');
		assert.deepEqual(subscribers.map(String), [ 'test:ios', '1', 'test:android', '1' ]);
	});

	it('refuses to start twice', async () => {
		const pusher = createPusher();
		await start(pusher);
		await assert.rejects(start(pusher), /already running/);
	});

	it('delivers APNS and FCM messages published on their channels', async () => {
		const pusher = createPusher();
		await start(pusher);

		await publish('test:ios', { identifier: 'i1', token: [ 'aa01', 'aa02' ], alert: 'hi', badge: 0 });
		await publish('test:android', { identifier: 'g1', registrationId: 'r1', data: { k: 'v' } });
		await eventually(() => eventsNamed(pusher, 'sent').length === 2);

		assert.deepEqual(apns.requests.map((r) => r.deviceToken).sort(), [ 'aa01', 'aa02' ]);
		assert.deepEqual(apns.requests[0].json, { aps: { alert: 'hi', badge: 0 } });
		assert.deepEqual(fcm.requests.map((r) => r.json.message), [ { token: 'r1', data: { k: 'v' } } ]);

		const received = eventsNamed(pusher, 'message');
		assert.deepEqual(received.map(([ , message, channel ]) => [ message.identifier, channel ]).sort(),
			[ [ 'g1', 'test:android' ], [ 'i1', 'test:ios' ] ]);
		for (const [ , , results ] of eventsNamed(pusher, 'sent'))
			assert.ok(results.every((r) => r.ok));

		// Without failover the lock is deleted once the work is done.
		await eventually(async () => (await lockKeys()).length === 0);
	});

	it('holds the lock until delivery has been attempted', async () => {
		let release;
		fcm.respond = () => new Promise((resolve) => { release = () => resolve({ status: 200 }); });
		const pusher = createPusher();
		await start(pusher);

		await publish('test:android', { identifier: 'slow', token: 't' });
		await eventually(() => release);
		assert.deepEqual(await lockKeys(), [ 'test_lock_slow' ]);

		release();
		await eventually(() => eventsNamed(pusher, 'sent').length === 1);
		await eventually(async () => (await lockKeys()).length === 0);
	});

	it('emits `unregistered` for dead device tokens', async () => {
		apns.respond = () => ({ status: 410, body: { reason: 'Unregistered', timestamp: Date.now() } });
		const pusher = createPusher();
		await start(pusher);
		await publish('test:ios', { identifier: 'u1', token: 'dead', alert: 'x' });
		await eventually(() => eventsNamed(pusher, 'unregistered').length === 1);
		const [ , result ] = eventsNamed(pusher, 'unregistered')[0];
		assert.deepEqual([ result.platform, result.recipient, result.error ], [ 'apns', 'dead', 'Unregistered' ]);
	});

	it('rejects invalid messages with an `invalid` event and sends nothing', async () => {
		const pusher = createPusher();
		await start(pusher);

		await publish('test:ios', 'not json');
		await publish('test:ios', { token: 'aa' });             // no identifier
		await publish('test:ios', { identifier: 'x', token: 'not-hex' });
		await publish('test:android', { identifier: 'x' });     // no token
		await eventually(() => eventsNamed(pusher, 'invalid').length === 4);

		const invalid = eventsNamed(pusher, 'invalid');
		assert.ok(invalid[0][1] instanceof SyntaxError);
		assert.deepEqual(invalid.map(([ , , channel, raw ]) => [ channel, raw ]), [
			[ 'test:ios', 'not json' ],
			[ 'test:ios', '{"token":"aa"}' ],
			[ 'test:ios', '{"identifier":"x","token":"not-hex"}' ],
			[ 'test:android', '{"identifier":"x"}' ]
		]);
		assert.match(invalid[1][1].message, /`identifier` is required/);
		assert.match(invalid[2][1].message, /hex/);
		assert.match(invalid[3][1].message, /`token`/);

		assert.equal(apns.requests.length + fcm.requests.length, 0);
		assert.equal(eventsNamed(pusher, 'error').length + eventsNamed(pusher, 'message').length, 0);
	});

	it('ignores channels it is not subscribed to', async () => {
		const pusher = createPusher({ channels: { 'test:android': 'fcm' } });
		await start(pusher);
		await publish('test:ios', { identifier: 'i', token: 'aa' });
		await publish('test:android', { identifier: 'g', token: 'r' });
		await eventually(() => fcm.requests.length === 1);
		assert.equal(apns.requests.length, 0);
	});

	it('sends each message once across instances sharing the lock (failover)', async () => {
		const options = { failoverEnabled: true, lock: { keyPrefix: 'test_lock_', lockTimeout: 200 } };
		const a = createPusher(options);
		const b = createPusher(options);
		await Promise.all([ start(a), start(b) ]);

		for (let i = 0; i < 5; i++)
			await publish('test:android', { identifier: 'm' + i, token: 'r' + i });

		await eventually(() => fcm.requests.length >= 5);
		// The standby instance cleans up the locks after `lockTimeout`.
		await eventually(async () => (await lockKeys()).length === 0);

		assert.equal(fcm.requests.length, 5);
		assert.deepEqual(fcm.requests.map((r) => r.json.message.token).sort(), [ 'r0', 'r1', 'r2', 'r3', 'r4' ]);
	});

	it('stop() unsubscribes and closes the connections; start() works again', async () => {
		const pusher = createPusher();
		await start(pusher);
		const client = pusher._client, subscriber = pusher._subscriber;
		await stop(pusher);
		pushers.splice(pushers.indexOf(pusher), 1);

		assert.equal(pusher.running, false);
		await eventually(() => !client.connected && !subscriber.connected);
		const subscribers = await command(publisher, 'pubsub', 'numsub', 'test:ios');
		assert.equal(String(subscribers[1]), '0');

		await start(pusher);
		pushers.push(pusher);
		await publish('test:ios', { identifier: 'again', token: 'aa' });
		await eventually(() => apns.requests.length === 1);
	});
});
