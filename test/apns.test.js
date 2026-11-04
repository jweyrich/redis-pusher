'use strict';
//
// APNS delivery against a local mock of Apple's HTTP/2 provider API.
//

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');
const { generateCredentials, startMockAPNS, apnsOptions } = require('./mocks');

const credentials = generateCredentials();
const T1 = 'aaaa0001';
const T2 = 'bbbb0002';

describe('APNS', { timeout: 30000 }, () => {
	let mock, pusher;

	const createPusher = (extra) => {
		pusher = RedisPusher({ apns: apnsOptions(credentials, mock, extra) });
		pusher.errors = [];
		pusher.on('error', (err) => pusher.errors.push(err));
		return pusher;
	};

	before(async () => { mock = await startMockAPNS(credentials.apns); });
	after(() => mock.close());
	beforeEach(() => {
		mock.requests.length = 0;
		mock.respond = () => ({ status: 200 });
	});
	afterEach(() => new Promise((resolve) => pusher.stop(resolve)));

	it('sends one authenticated request per device token', async () => {
		createPusher();
		const results = await pusher.send('apns', { token: [ T1, T2 ], alert: 'Hello', badge: 1, payload: { k: 'v' } });

		assert.deepEqual(results.map((r) => [ r.platform, r.recipient, r.ok ]), [ [ 'apns', T1, true ], [ 'apns', T2, true ] ]);
		assert.ok(results.every((r) => /^apns-\d+$/.test(r.id)));
		assert.equal(mock.requests.length, 2);

		const request = mock.requests.find((r) => r.deviceToken === T1);
		assert.equal(request.method, 'POST');
		assert.equal(request.path, '/3/device/' + T1);
		assert.equal(request.headers['apns-topic'], 'com.example.app');
		assert.equal(request.headers['apns-push-type'], 'alert');
		assert.equal(request.headers['apns-priority'], '10');
		assert.deepEqual(request.json, { k: 'v', aps: { alert: 'Hello', badge: 1 } });

		// ES256 provider token, as Apple expects.
		assert.deepEqual(request.jwt.header, { alg: 'ES256', kid: credentials.apns.keyId });
		assert.equal(request.jwt.claims.iss, credentials.apns.teamId);
		assert.ok(Math.abs(request.jwt.claims.iat - Date.now() / 1000) < 5);
	});

	it('reuses the provider token across requests', async () => {
		createPusher();
		await pusher.send('apns', { token: T1, alert: 'a' });
		await pusher.send('apns', { token: T1, alert: 'b' });
		assert.equal(mock.requests[0].headers.authorization, mock.requests[1].headers.authorization);
	});

	it('reports 410 Unregistered with its timestamp, without retrying', async () => {
		const timestamp = Date.UTC(2026, 0, 2);
		mock.respond = (r) => r.deviceToken === T2 ? { status: 410, body: { reason: 'Unregistered', timestamp } } : { status: 200 };
		createPusher();
		const events = [];
		for (const name of [ 'transmitted', 'transmissionError', 'unregistered' ])
			pusher.on(name, (result) => events.push([ name, result.recipient ]));

		const results = await pusher.send('apns', { token: [ T1, T2 ], alert: 'x' });

		assert.equal(results[0].ok, true);
		const failed = results[1];
		assert.equal(failed.ok, false);
		assert.equal(failed.status, 410);
		assert.equal(failed.error, 'Unregistered');
		assert.equal(failed.unregistered, true);
		assert.deepEqual(failed.time, new Date(timestamp));
		assert.equal(mock.requests.filter((r) => r.deviceToken === T2).length, 1);
		assert.deepEqual(events.sort(), [ [ 'transmissionError', T2 ], [ 'transmitted', T1 ], [ 'unregistered', T2 ] ]);
	});

	it('does not retry permanent errors', async () => {
		mock.respond = () => ({ status: 400, body: { reason: 'BadDeviceToken' } });
		createPusher();
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.deepEqual([ result.ok, result.status, result.error, result.unregistered ], [ false, 400, 'BadDeviceToken', undefined ]);
		assert.equal(mock.requests.length, 1);
	});

	it('retries 429/5xx with backoff, honouring Retry-After', async () => {
		let calls = 0;
		mock.respond = () => {
			calls++;
			if (calls === 1) return { status: 429, headers: { 'retry-after': '0' }, body: { reason: 'TooManyRequests' } };
			if (calls === 2) return { status: 503, body: { reason: 'ServiceUnavailable' } };
			return { status: 200 };
		};
		createPusher();
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.equal(result.ok, true);
		assert.equal(calls, 3);
	});

	it('gives up after `retries` attempts', async () => {
		mock.respond = () => ({ status: 500, body: { reason: 'InternalServerError' } });
		createPusher({ retries: 2 });
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.deepEqual([ result.ok, result.error ], [ false, 'InternalServerError' ]);
		assert.equal(mock.requests.length, 3);
	});

	it('refreshes the provider token on ExpiredProviderToken', async () => {
		let first = true;
		mock.respond = () => {
			if (first) {
				first = false;
				return { status: 403, body: { reason: 'ExpiredProviderToken' } };
			}
			return { status: 200 };
		};
		createPusher();
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.equal(result.ok, true);
		assert.equal(mock.requests.length, 2);
		assert.ok(mock.requests[1].jwt, 'retried with a valid token');
	});

	it('emits a single `error` for rejected credentials', async () => {
		createPusher({ keyId: 'WRONGKEYID' });
		const results = await pusher.send('apns', { token: [ T1, T2 ], alert: 'x' });
		assert.ok(results.every((r) => !r.ok && r.error === 'InvalidProviderToken'));
		assert.equal(pusher.errors.length, 1);
		assert.equal(pusher.errors[0].source, 'apns');
		assert.match(pusher.errors[0].message, /InvalidProviderToken/);
	});

	it('limits concurrent requests to `concurrency`', async () => {
		mock.respond = () => new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 20));
		mock.state.maxActive = 0;
		createPusher({ concurrency: 3 });
		const tokens = Array.from({ length: 10 }, (_, i) => 'cc' + String(i).padStart(4, '0'));
		const results = await pusher.send('apns', { token: tokens, alert: 'x' });
		assert.equal(results.filter((r) => r.ok).length, 10);
		assert.equal(mock.state.maxActive, 3);
	});

	it('times out slow requests and retries them', async () => {
		let calls = 0;
		mock.respond = () => ++calls === 1
			? new Promise((resolve) => setTimeout(() => resolve({ status: 200 }), 500))
			: { status: 200 };
		createPusher({ requestTimeout: 100 });
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.equal(result.ok, true);
		assert.equal(calls, 2);
	});

	it('reports network errors as failed results after retrying', async () => {
		pusher = RedisPusher({ apns: apnsOptions(credentials, { url: 'http://127.0.0.1:1' }, { retries: 1 }) });
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.equal(result.ok, false);
		assert.equal(result.error, 'ECONNREFUSED');
	});

	it('reconnects after the server drops the connection', async () => {
		createPusher();
		assert.equal((await pusher.send('apns', { token: T1, alert: 'a' }))[0].ok, true);
		mock.dropConnections();
		assert.equal((await pusher.send('apns', { token: T1, alert: 'b' }))[0].ok, true);
		assert.equal(mock.requests.length, 2);
	});

	it('retries a request whose connection dropped mid-flight', async () => {
		let calls = 0;
		mock.respond = () => {
			if (++calls === 1) {
				setImmediate(() => mock.dropConnections());
				return new Promise(() => {}); // Never answers.
			}
			return { status: 200 };
		};
		createPusher();
		const [ result ] = await pusher.send('apns', { token: T1, alert: 'x' });
		assert.equal(result.ok, true);
		assert.equal(calls, 2);
	});
});
