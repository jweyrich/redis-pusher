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
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

describe('with Redis', { skip: !redisAvailable && 'redis-server is not installed', timeout: 60000 }, () => {
	let server, publisher, apns, fcm;
	const pushers = [];

	function createPusher(redisOptions, extra) {
		const pusher = RedisPusher(Object.assign({
			apns: apnsOptions(credentials, apns),
			fcm: fcmOptions(credentials, fcm),
			redis: Object.assign({
				port: server.port,
				channels: { 'test:ios': 'apns', 'test:android': 'fcm' },
				lock: { keyPrefix: 'test_lock_' }
			}, redisOptions)
		}, extra));
		pusher.events = [];
		for (const name of [ 'ready', 'message', 'invalid', 'sent', 'unregistered', 'error' ])
			pusher.on(name, (...args) => pusher.events.push([ name, ...args ]));
		pushers.push(pusher);
		return pusher;
	}

	const eventsNamed = (pusher, name) => pusher.events.filter(([ event ]) => event === name);
	const publish = (channel, message) =>
		publisher.publish(channel, typeof message === 'string' ? message : JSON.stringify(message));
	const lockKeys = () => publisher.keys('test_lock_*');
	const fcmRequestsFor = (token) => fcm.requests.filter((r) => r.json.message.token === token);

	before(async () => {
		server = await startRedis();
		publisher = await server.client();
		[ apns, fcm ] = await Promise.all([ startMockAPNS(credentials.apns), startMockFCM(credentials.fcm) ]);
	});

	after(async () => {
		await publisher.close();
		await Promise.all([ server.stop(), apns.close(), fcm.close() ]);
	});

	beforeEach(async () => {
		apns.requests.length = 0;
		fcm.requests.length = 0;
		apns.respond = () => ({ status: 200 });
		fcm.respond = () => ({ status: 200 });
		await publisher.flushDb();
	});

	afterEach(async () => {
		await Promise.all(pushers.splice(0).map(stop));
	});

	it('emits `ready` and calls back once subscribed to every channel', async () => {
		const pusher = createPusher();
		await start(pusher);
		assert.deepEqual(pusher.events, [ [ 'ready' ] ]);
		assert.equal(pusher.running, true);

		const subscribers = await command(publisher, 'PUBSUB', 'NUMSUB', 'test:ios', 'test:android');
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
		assert.match(await publisher.get('test_lock_slow'), /^1:/);

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

	it('only receives the channels it is subscribed to (sharding)', async () => {
		const a = createPusher({ channels: { 'shard:a': 'fcm' } });
		const b = createPusher({ channels: { 'shard:b': 'fcm' } });
		await Promise.all([ start(a), start(b) ]);

		await publish('shard:a', { identifier: 'a1', token: 'ta' });
		await publish('shard:b', { identifier: 'b1', token: 'tb' });
		await publish('test:android', { identifier: 'n1', token: 'tn' }); // Nobody listens here.
		await eventually(() => fcm.requests.length === 2);
		await delay(100);

		const identifiers = (pusher) => eventsNamed(pusher, 'message').map(([ , message ]) => message.identifier);
		assert.deepEqual(identifiers(a), [ 'a1' ]);
		assert.deepEqual(identifiers(b), [ 'b1' ]);
		assert.deepEqual(fcm.requests.map((r) => r.json.message.token).sort(), [ 'ta', 'tb' ]);
	});

	describe('failover', () => {
		const FAILOVER = { failoverEnabled: true, lock: { keyPrefix: 'test_lock_', lockTimeout: 200 } };

		it('sends each message once across instances sharing the lock', async () => {
			const a = createPusher(FAILOVER);
			const b = createPusher(FAILOVER);
			await Promise.all([ start(a), start(b) ]);

			for (let i = 0; i < 5; i++)
				await publish('test:android', { identifier: 'm' + i, token: 'r' + i });

			await eventually(() => fcm.requests.length >= 5);
			// Wait until the standby has seen every DONE marker and stopped.
			await eventually(() => a._inflight.size === 0 && b._inflight.size === 0);

			assert.equal(fcm.requests.length, 5);
			assert.deepEqual(fcm.requests.map((r) => r.json.message.token).sort(), [ 'r0', 'r1', 'r2', 'r3', 'r4' ]);
			assert.deepEqual(await Promise.all((await lockKeys()).map((key) => publisher.get(key))),
				[ 'DONE', 'DONE', 'DONE', 'DONE', 'DONE' ]);
			// The DONE markers expire on their own.
			await eventually(async () => (await lockKeys()).length === 0, 5000);
		});

		it('takes over when the instance holding the lock dies', async () => {
			// Simulate an instance that acquired the lock and then crashed: its
			// lock stops being renewed and expires.
			await publisher.set('test_lock_crash', '1:dead-instance', { expiration: { type: 'PX', value: 300 } });
			const standby = createPusher(FAILOVER);
			await start(standby);

			await publish('test:android', { identifier: 'crash', token: 'tc' });
			await eventually(() => eventsNamed(standby, 'sent').length === 1);

			assert.equal(fcmRequestsFor('tc').length, 1);
			await eventually(() => standby._inflight.size === 0);
			assert.equal(await publisher.get('test_lock_crash'), 'DONE');
		});

		it('does not take over from a live instance that is still delivering', async () => {
			// Delivery takes several lockTimeouts; the holder keeps renewing its lock.
			fcm.respond = () => delay(700).then(() => ({ status: 200 }));
			const a = createPusher(FAILOVER);
			const b = createPusher(FAILOVER);
			await Promise.all([ start(a), start(b) ]);

			await publish('test:android', { identifier: 'long', token: 'tl' });
			await eventually(() => eventsNamed(a, 'message').length === 1 && eventsNamed(b, 'message').length === 1);
			await eventually(() => a._inflight.size === 0 && b._inflight.size === 0, 5000);

			assert.equal(fcmRequestsFor('tl').length, 1);
			assert.equal(eventsNamed(a, 'sent').length + eventsNamed(b, 'sent').length, 1);
		});

		it('skips a message another instance already delivered', async () => {
			await publisher.set('test_lock_done', 'DONE', { expiration: { type: 'PX', value: 5000 } });
			const pusher = createPusher(FAILOVER);
			await start(pusher);
			await publish('test:android', { identifier: 'done', token: 'td' });
			await eventually(() => eventsNamed(pusher, 'message').length === 1);
			await eventually(() => pusher._inflight.size === 0);
			assert.equal(fcmRequestsFor('td').length, 0);
		});

		it('gives up after `maxAttempts`', async () => {
			await publisher.set('test_lock_max', '5:dead-instance', { expiration: { type: 'PX', value: 300 } });
			const pusher = createPusher({ failoverEnabled: true, lock: { keyPrefix: 'test_lock_', lockTimeout: 200, maxAttempts: 5 } });
			await start(pusher);
			await publish('test:android', { identifier: 'max', token: 'tm' });
			await eventually(() => eventsNamed(pusher, 'message').length === 1);
			await eventually(() => pusher._inflight.size === 0, 3000);
			assert.equal(fcmRequestsFor('tm').length, 0);
		});

		it('stop() stops waiting as a standby', async () => {
			await publisher.set('test_lock_wait', '1:other-instance', { expiration: { type: 'PX', value: 10000 } });
			const pusher = createPusher(FAILOVER);
			await start(pusher);
			await publish('test:android', { identifier: 'wait', token: 'tw' });
			await eventually(() => pusher._inflight.size === 1);

			const started = Date.now();
			await stop(pusher);
			pushers.splice(pushers.indexOf(pusher), 1);
			assert.ok(Date.now() - started < 1000, 'stopped promptly');
			assert.equal(fcmRequestsFor('tw').length, 0);
			assert.equal(eventsNamed(pusher, 'error').length, 0);
		});
	});

	it('without failover, instances that lose the race skip the message', async () => {
		const a = createPusher();
		const b = createPusher();
		await Promise.all([ start(a), start(b) ]);

		for (let i = 0; i < 5; i++)
			await publish('test:android', { identifier: 'n' + i, token: 'n' + i });

		await eventually(() => fcm.requests.length >= 5);
		await eventually(() => a._inflight.size === 0 && b._inflight.size === 0);
		assert.equal(fcm.requests.length, 5);
		assert.deepEqual(await lockKeys(), []);
	});

	it('keeps receiving messages after Redis drops its connections', async () => {
		const pusher = createPusher();
		await start(pusher);
		await command(publisher, 'CLIENT', 'KILL', 'TYPE', 'pubsub');
		await command(publisher, 'CLIENT', 'KILL', 'TYPE', 'normal', 'SKIPME', 'yes');

		// Wait for the subscriber to reconnect and resubscribe.
		await eventually(async () => String((await command(publisher, 'PUBSUB', 'NUMSUB', 'test:android'))[1]) === '1', 5000);
		await publish('test:android', { identifier: 'r1', token: 'tr' });
		await eventually(() => fcmRequestsFor('tr').length === 1, 5000);
		await eventually(async () => (await lockKeys()).length === 0);
	});

	it('authenticates with an ACL user via options or a URL', async () => {
		await command(publisher, 'ACL', 'SETUSER', 'pusher', 'on', '>s3cret', '~*', '&*', '+@all');
		try {
			const viaOptions = createPusher({ username: 'pusher', password: 's3cret', channels: { 'auth:a': 'fcm' } });
			const viaLegacyPass = createPusher({ username: 'pusher', pass: 's3cret', channels: { 'auth:b': 'fcm' } });
			const viaURL = createPusher({ url: 'redis://pusher:s3cret@127.0.0.1:' + server.port, port: 1, channels: { 'auth:c': 'fcm' } });
			await Promise.all([ start(viaOptions), start(viaLegacyPass), start(viaURL) ]);

			const clients = await command(publisher, 'CLIENT', 'LIST');
			assert.equal((String(clients).match(/user=pusher/g) || []).length, 6);

			const wrong = createPusher({ username: 'pusher', password: 'wrong', channels: { 'auth:d': 'fcm' } });
			const errors = [];
			wrong.on('error', (err) => errors.push(err));
			wrong.start();
			await eventually(() => errors.length > 0);
			assert.match(errors[0].message, /WRONGPASS|invalid username-password/i);
		} finally {
			await command(publisher, 'ACL', 'DELUSER', 'pusher');
		}
	});

	it('stop() closes the connections; start() works again', async () => {
		const pusher = createPusher();
		await start(pusher);
		const client = pusher._client, subscriber = pusher._subscriber;
		await stop(pusher);
		pushers.splice(pushers.indexOf(pusher), 1);

		assert.equal(pusher.running, false);
		assert.ok(!client.isOpen && !subscriber.isOpen);
		const subscribers = await command(publisher, 'PUBSUB', 'NUMSUB', 'test:ios');
		assert.equal(String(subscribers[1]), '0');

		await start(pusher);
		pushers.push(pusher);
		await publish('test:ios', { identifier: 'again', token: 'aa' });
		await eventually(() => apns.requests.length === 1);
	});

	it('stop() while still connecting calls back the pending start()', async () => {
		const pusher = createPusher({ port: 1 }); // Nothing listens there.
		pusher.on('error', () => {});
		const started = new Promise((resolve) => pusher.start(resolve));
		await delay(50);
		await stop(pusher);
		pushers.splice(pushers.indexOf(pusher), 1);
		assert.match((await started).message, /stopped before it was ready/);
	});
});
