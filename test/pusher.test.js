'use strict';
//
// Pusher API behaviour that does not need a Redis server.
//

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const path = require('node:path');
const RedisPusher = require('..');
const { generateCredentials, startMockAPNS, startMockFCM, apnsOptions, fcmOptions } = require('./mocks');

const credentials = generateCredentials();

describe('Pusher', { timeout: 30000 }, () => {
	let apns, fcm;
	const pushers = [];

	const createPusher = (options = {}) => {
		const pusher = RedisPusher(Object.assign({
			apns: apnsOptions(credentials, apns),
			fcm: fcmOptions(credentials, fcm)
		}, options));
		pushers.push(pusher);
		return pusher;
	};

	before(async () => {
		[ apns, fcm ] = await Promise.all([ startMockAPNS(credentials.apns), startMockFCM(credentials.fcm) ]);
	});
	after(async () => {
		await Promise.all(pushers.map((pusher) => new Promise((resolve) => pusher.stop(resolve))));
		await Promise.all([ apns.close(), fcm.close() ]);
	});
	beforeEach(() => {
		apns.respond = () => ({ status: 200 });
		fcm.respond = () => ({ status: 200 });
	});

	it('can be created with or without `new`', () => {
		assert.ok(new RedisPusher({}) instanceof RedisPusher.Pusher);
		assert.ok(RedisPusher({}) instanceof RedisPusher.Pusher);
		assert.ok(RedisPusher.createPusher({}) instanceof RedisPusher.Pusher);
	});

	it('does not connect anywhere until used', () => {
		const pusher = createPusher({ redis: { channels: [ 'a:android' ] } });
		assert.equal(pusher.running, false);
		assert.equal(pusher._client, null);
		assert.equal(pusher._transports.fcm.client.session, null);
	});

	describe('send()', () => {
		it('resolves with one result per recipient', async () => {
			const results = await createPusher().send('apns', { token: [ 'aa', 'bb' ], alert: 'x' });
			assert.equal(results.length, 2);
			assert.deepEqual(results.map((r) => [ r.platform, r.recipient, r.ok ]), [ [ 'apns', 'aa', true ], [ 'apns', 'bb', true ] ]);
		});

		it('accepts a callback instead', (t, done) => {
			const returned = createPusher().send('fcm', { token: 't' }, (err, results) => {
				assert.equal(err, null);
				assert.equal(results[0].ok, true);
				done();
			});
			assert.equal(returned, undefined);
		});

		it('passes validation errors to the callback', (t, done) => {
			createPusher().send('fcm', { data: {} }, (err) => {
				assert.match(err.message, /`token`/);
				done();
			});
		});

		it('accepts JSON, message instances, and the `gcm` alias', async () => {
			const pusher = createPusher();
			assert.equal((await pusher.send('apns', '{"token":"aa","alert":"x"}'))[0].ok, true);
			assert.equal((await pusher.send('fcm', new RedisPusher.FCMMessage({ token: 't' })))[0].ok, true);
			assert.equal((await pusher.send('gcm', { registrationId: 'r' }))[0].platform, 'fcm');
		});

		it('rejects invalid messages, unconfigured platforms and mismatched messages', async () => {
			const pusher = createPusher({ apns: false });
			await assert.rejects(pusher.send('fcm', { data: {} }), /`token`/);
			await assert.rejects(pusher.send('fcm', 'not json'), SyntaxError);
			await assert.rejects(pusher.send('apns', { token: 'aa' }), /apns is not configured/);
			await assert.rejects(pusher.send('fcm', new RedisPusher.APNSMessage({ token: 'aa' })), /Cannot send a apns message via fcm/);
		});

		it('resolves (not rejects) when delivery fails', async () => {
			apns.respond = () => ({ status: 400, body: { reason: 'BadDeviceToken' } });
			const [ result ] = await createPusher().send('apns', { token: 'aa', alert: 'x' });
			assert.deepEqual([ result.ok, result.error ], [ false, 'BadDeviceToken' ]);
		});
	});

	describe('events', () => {
		it('emits transmitted, transmissionError, unregistered and sent', async () => {
			apns.respond = (r) => {
				if (r.deviceToken === 'bb') return { status: 400, body: { reason: 'BadDeviceToken' } };
				if (r.deviceToken === 'cc') return { status: 410, body: { reason: 'Unregistered' } };
				return { status: 200 };
			};
			const pusher = createPusher();
			const events = [];
			for (const name of [ 'transmitted', 'transmissionError', 'unregistered' ])
				pusher.on(name, (result) => events.push(name + ':' + result.recipient));
			let sent;
			pusher.on('sent', (message, results) => { sent = { message, results }; });

			const results = await pusher.send('apns', { identifier: 'id', token: [ 'aa', 'bb', 'cc' ], alert: 'x' });

			assert.deepEqual(events.sort(), [
				'transmissionError:bb', 'transmissionError:cc', 'transmitted:aa', 'unregistered:cc'
			]);
			assert.equal(sent.message.identifier, 'id');
			assert.strictEqual(sent.results, results);
		});
	});

	describe('logger', () => {
		it('is silent by default and uses the given logger otherwise', async () => {
			const lines = [];
			const logger = { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) };
			await createPusher().send('fcm', { token: 't' });
			assert.equal(lines.length, 0);

			await createPusher({ logger }).send('fcm', { token: 't' });
			assert.ok(lines.some(([ format ]) => format.includes('Sending notification')), JSON.stringify(lines));
			assert.ok(lines.some(([ format ]) => format.includes('Transmitted')), JSON.stringify(lines));
		});
	});

	describe('start() / stop()', () => {
		it('fails to start without channels', (t, done) => {
			createPusher().start((err) => {
				assert.match(err.message, /No channels configured/);
				done();
			});
		});

		it('stop() on a pusher that was never started calls back without error', (t, done) => {
			RedisPusher({}).stop((err) => {
				assert.equal(err, null);
				done();
			});
		});

		it('stop() closes the APNS/FCM connections; send() still works afterwards', async () => {
			const pusher = createPusher();
			await pusher.send('apns', { token: 'aa', alert: 'x' });
			const session = pusher._transports.apns.client.session;
			assert.ok(session && !session.closed);
			await new Promise((resolve) => pusher.stop(resolve));
			assert.ok(session.closed);
			assert.equal((await pusher.send('apns', { token: 'aa', alert: 'y' }))[0].ok, true);
		});
	});

	it('does not keep the process alive once sends complete', async () => {
		// A script that sends without calling stop() must exit on its own.
		const script = `
			const RedisPusher = require(${JSON.stringify(path.join(__dirname, '..'))});
			const pusher = RedisPusher(${JSON.stringify({
				apns: apnsOptions(credentials, apns),
				fcm: fcmOptions(credentials, fcm)
			})});
			Promise.all([
				pusher.send('apns', { token: 'aa', alert: 'x' }),
				pusher.send('fcm', { token: 't' })
			]).then((results) => console.log(JSON.stringify(results.map((r) => r[0].ok))));
		`;
		const child = spawn(process.execPath, [ '-e', script ], { stdio: [ 'ignore', 'pipe', 'inherit' ] });
		let output = '';
		child.stdout.on('data', (chunk) => { output += chunk; });
		const timer = setTimeout(() => child.kill(), 5000);
		const code = await new Promise((resolve) => child.on('exit', resolve));
		clearTimeout(timer);
		assert.equal(code, 0, 'exited by itself');
		assert.equal(output.trim(), '[true,true]');
	});
});
