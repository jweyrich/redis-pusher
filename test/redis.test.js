'use strict';
//
// End-to-end tests against a real redis-server (spawned on a free port, or
// $REDIS_PORT). Skipped when redis-server is not installed.
//

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');
const { stubSenders, eventually, startRedis, redisAvailable, start, stop, command } = require('./helpers');

const APNS = { certificate: Buffer.from('fake'), feedback: { enabled: false } };
const GCM = { options: { key: 'key' } };

describe('with Redis', { skip: !redisAvailable && 'redis-server is not installed' }, () => {
	let server, publisher, sent;
	const pushers = [];

	function createPusher(redisOptions) {
		const pusher = RedisPusher({
			apns: APNS,
			gcm: GCM,
			redis: Object.assign({
				port: server.port,
				channels: { 'test:ios': 'apns', 'test:android': 'gcm' },
				lock: { keyPrefix: 'test_lock_' }
			}, redisOptions)
		});
		pusher.events = [];
		for (const name of [ 'ready', 'message', 'invalid', 'sent', 'error' ])
			pusher.on(name, (...args) => pusher.events.push([ name, ...args ]));
		pushers.push(pusher);
		return pusher;
	}

	const publish = (channel, message) =>
		command(publisher, 'publish', channel, typeof message === 'string' ? message : JSON.stringify(message));
	const lockKeys = () => command(publisher, 'keys', 'test_lock_*');

	before(async () => {
		server = await startRedis();
		publisher = server.client();
		sent = stubSenders();
	});

	after(async () => {
		sent.restore();
		await new Promise((resolve) => publisher.quit(resolve));
		await server.stop();
	});

	beforeEach(async () => {
		sent.reset();
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

	it('delivers APNS and GCM messages published on their channels', async () => {
		const pusher = createPusher();
		await start(pusher);

		await publish('test:ios', { identifier: 'i1', token: [ 't1', 't2' ], alert: 'hi', badge: 0 });
		await publish('test:android', { identifier: 'g1', registrationId: 'r1' });
		await eventually(() => sent.apns.length === 1 && sent.gcm.length === 1);

		const apns = sent.apns[0].message;
		assert.deepEqual(apns.token, [ 't1', 't2' ]);
		assert.strictEqual(apns.badge, 0);
		assert.deepEqual(sent.gcm[0].message.registrationId, [ 'r1' ]);

		const received = pusher.events.filter(([ name ]) => name === 'message');
		assert.deepEqual(received.map(([ , message, channel ]) => [ message.identifier, channel ]),
			[ [ 'i1', 'test:ios' ], [ 'g1', 'test:android' ] ]);
		assert.equal(pusher.events.filter(([ name ]) => name === 'sent').length, 2);

		// Without failover the lock is deleted once the work is done.
		await eventually(async () => (await lockKeys()).length === 0);
	});

	it('rejects invalid messages with an `invalid` event and sends nothing', async () => {
		const pusher = createPusher();
		await start(pusher);

		await publish('test:ios', 'not json');
		await publish('test:ios', { token: 't' });              // no identifier
		await publish('test:android', { identifier: 'x' });     // no registrationId
		await eventually(() => pusher.events.filter(([ name ]) => name === 'invalid').length === 3);

		const invalid = pusher.events.filter(([ name ]) => name === 'invalid');
		assert.ok(invalid[0][1] instanceof SyntaxError);
		assert.deepEqual(invalid.map(([ , , channel, raw ]) => [ channel, raw ]), [
			[ 'test:ios', 'not json' ],
			[ 'test:ios', '{"token":"t"}' ],
			[ 'test:android', '{"identifier":"x"}' ]
		]);
		assert.match(invalid[1][1].message, /`identifier` is required/);
		assert.match(invalid[2][1].message, /`registrationId`/);

		assert.equal(sent.apns.length + sent.gcm.length, 0);
		assert.ok(!pusher.events.some(([ name ]) => name === 'error' || name === 'message'));
	});

	it('ignores channels it is not subscribed to', async () => {
		const pusher = createPusher({ channels: { 'test:android': 'gcm' } });
		await start(pusher);
		await publish('test:ios', { identifier: 'i', token: 't' });
		await publish('test:android', { identifier: 'g', registrationId: 'r' });
		await eventually(() => sent.gcm.length === 1);
		assert.equal(sent.apns.length, 0);
	});

	it('sends each message once across instances sharing the lock (failover)', async () => {
		const options = { failoverEnabled: true, lock: { keyPrefix: 'test_lock_', lockTimeout: 200 } };
		const a = createPusher(options);
		const b = createPusher(options);
		await Promise.all([ start(a), start(b) ]);

		for (let i = 0; i < 5; i++)
			await publish('test:android', { identifier: 'm' + i, registrationId: 'r' });

		await eventually(() => sent.gcm.length >= 5);
		// The standby instance cleans up the locks after `lockTimeout`.
		await eventually(async () => (await lockKeys()).length === 0);

		assert.equal(sent.gcm.length, 5);
		assert.deepEqual(sent.gcm.map(({ message }) => message.identifier).sort(), [ 'm0', 'm1', 'm2', 'm3', 'm4' ]);
	});

	it('stop() unsubscribes and closes the connections', async () => {
		const pusher = createPusher();
		await start(pusher);
		const client = pusher._client, subscriber = pusher._subscriber;
		await stop(pusher);
		pushers.splice(pushers.indexOf(pusher), 1);

		assert.equal(pusher.running, false);
		await eventually(() => !client.connected && !subscriber.connected);
		const subscribers = await command(publisher, 'pubsub', 'numsub', 'test:ios');
		assert.equal(String(subscribers[1]), '0');

		// It can be started again afterwards.
		await start(pusher);
		pushers.push(pusher);
		await publish('test:ios', { identifier: 'again', token: 't' });
		await eventually(() => sent.apns.length === 1);
	});

	it('emits `error` when the APNS feedback certificate cannot be loaded', async () => {
		const pusher = RedisPusher({
			redis: { port: server.port, channels: [ 'test:ios' ] },
			apns: { certificate: '/nonexistent/cert.p12', feedback: { interval: 0 } }
		});
		pushers.push(pusher);
		const errors = [];
		pusher.on('error', (err) => errors.push(err));
		await start(pusher);
		await eventually(() => errors.length > 0);
		assert.equal(errors[0].source, 'apns-feedback');
		assert.match(errors[0].message, /ENOENT/);
	});
});
