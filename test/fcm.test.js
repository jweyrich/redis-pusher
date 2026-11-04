'use strict';
//
// FCM delivery against a local mock of Google's OAuth token endpoint and the
// FCM HTTP v1 API.
//

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');
const { generateCredentials, startMockFCM, fcmError, fcmOptions } = require('./mocks');

const credentials = generateCredentials();
const SEND_PATH = '/v1/projects/test-project/messages:send';

describe('FCM', { timeout: 30000 }, () => {
	let mock, pusher;

	const createPusher = (extra) => {
		pusher = RedisPusher({ fcm: fcmOptions(credentials, mock, extra) });
		pusher.errors = [];
		pusher.on('error', (err) => pusher.errors.push(err));
		return pusher;
	};

	before(async () => { mock = await startMockFCM(credentials.fcm); });
	after(() => mock.close());
	beforeEach(() => {
		mock.requests.length = 0;
		mock.tokenRequests.length = 0;
		mock.issued.length = 0;
		mock.respond = () => ({ status: 200 });
		mock.respondToken = null;
		mock.revoke();
	});
	afterEach(() => new Promise((resolve) => pusher.stop(resolve)));

	it('gets an OAuth access token with a signed service-account assertion', async () => {
		createPusher();
		await pusher.send('fcm', { token: 't1' });

		assert.equal(mock.tokenRequests.length, 1);
		const { form, jwt, headers } = mock.tokenRequests[0];
		assert.equal(headers['content-type'], 'application/x-www-form-urlencoded');
		assert.equal(form.get('grant_type'), 'urn:ietf:params:oauth:grant-type:jwt-bearer');
		assert.ok(jwt, 'assertion is signed with the service account key');
		assert.deepEqual(jwt.header, { alg: 'RS256', typ: 'JWT', kid: 'key-1' });
		assert.equal(jwt.claims.iss, credentials.fcm.serviceAccount.client_email);
		assert.equal(jwt.claims.scope, 'https://www.googleapis.com/auth/firebase.messaging');
		assert.equal(jwt.claims.aud, mock.url + '/token');
		assert.equal(jwt.claims.exp - jwt.claims.iat, 3600);
	});

	it('sends one v1 request per registration token', async () => {
		createPusher();
		const results = await pusher.send('fcm', {
			token: [ 't1', 't2' ], notification: { title: 'Hi' }, data: { n: 1 }, collapseKey: 'c', timeToLive: 60
		});

		assert.deepEqual(results.map((r) => [ r.platform, r.recipient, r.ok ]), [ [ 'fcm', 't1', true ], [ 'fcm', 't2', true ] ]);
		assert.ok(results.every((r) => /^projects\/test-project\/messages\/\d+$/.test(r.id)));

		const request = mock.requests.find((r) => r.json.message.token === 't1');
		assert.equal(request.method, 'POST');
		assert.equal(request.path, SEND_PATH);
		assert.equal(request.headers['content-type'], 'application/json');
		assert.equal(request.headers.authorization, 'Bearer ' + mock.issued[0]);
		assert.deepEqual(request.json, {
			message: {
				token: 't1',
				notification: { title: 'Hi' },
				data: { n: '1' },
				android: { collapse_key: 'c', ttl: '60s' }
			}
		});
	});

	it('caches the access token, and concurrent sends share one token request', async () => {
		createPusher();
		await Promise.all([ pusher.send('fcm', { token: [ 'a', 'b', 'c' ] }), pusher.send('fcm', { token: 'd' }) ]);
		await pusher.send('fcm', { token: 'e' });
		assert.equal(mock.tokenRequests.length, 1);
		assert.ok(mock.requests.every((r) => r.accessToken === mock.issued[0]));
	});

	it('refreshes the access token once when it is rejected', async () => {
		createPusher();
		await pusher.send('fcm', { token: 'a' });
		mock.revoke();
		const results = await pusher.send('fcm', { token: [ 'b', 'c', 'd' ] });
		assert.ok(results.every((r) => r.ok));
		assert.equal(mock.tokenRequests.length, 2);
	});

	it('reports UNREGISTERED tokens without retrying', async () => {
		mock.respond = (r) => r.json.message.token === 'gone'
			? fcmError(404, 'NOT_FOUND', 'UNREGISTERED', 'Requested entity was not found.')
			: { status: 200 };
		createPusher();
		const unregistered = [];
		pusher.on('unregistered', (result) => unregistered.push(result.recipient));

		const results = await pusher.send('fcm', { token: [ 'ok', 'gone' ] });
		assert.equal(results[0].ok, true);
		assert.deepEqual(
			[ results[1].ok, results[1].status, results[1].error, results[1].unregistered, results[1].message ],
			[ false, 404, 'UNREGISTERED', true, 'Requested entity was not found.' ]);
		assert.deepEqual(unregistered, [ 'gone' ]);
		assert.equal(mock.requests.filter((r) => r.json.message.token === 'gone').length, 1);
	});

	it('does not retry INVALID_ARGUMENT', async () => {
		mock.respond = () => fcmError(400, 'INVALID_ARGUMENT', 'INVALID_ARGUMENT', 'The registration token is not a valid FCM registration token');
		createPusher();
		const [ result ] = await pusher.send('fcm', { token: 'bad' });
		assert.deepEqual([ result.ok, result.error, result.unregistered ], [ false, 'INVALID_ARGUMENT', undefined ]);
		assert.equal(mock.requests.length, 1);
	});

	it('retries QUOTA_EXCEEDED and UNAVAILABLE', async () => {
		let calls = 0;
		mock.respond = () => {
			calls++;
			if (calls === 1) return Object.assign(fcmError(429, 'RESOURCE_EXHAUSTED', 'QUOTA_EXCEEDED'), { headers: { 'retry-after': '0' } });
			if (calls === 2) return fcmError(503, 'UNAVAILABLE', 'UNAVAILABLE');
			return { status: 200 };
		};
		createPusher();
		const [ result ] = await pusher.send('fcm', { token: 't' });
		assert.equal(result.ok, true);
		assert.equal(calls, 3);
	});

	it('does not refresh the token on THIRD_PARTY_AUTH_ERROR', async () => {
		mock.respond = () => fcmError(401, 'UNAUTHENTICATED', 'THIRD_PARTY_AUTH_ERROR');
		createPusher();
		const [ result ] = await pusher.send('fcm', { token: 't' });
		assert.deepEqual([ result.ok, result.error ], [ false, 'THIRD_PARTY_AUTH_ERROR' ]);
		assert.equal(mock.tokenRequests.length, 1);
		assert.equal(mock.requests.length, 1);
	});

	it('fails every recipient and emits one `error` when the token request is rejected', async () => {
		mock.respondToken = () => ({ status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } });
		createPusher();
		const results = await pusher.send('fcm', { token: [ 'a', 'b' ] });
		assert.ok(results.every((r) => !r.ok && /Invalid JWT Signature/.test(r.error)));
		assert.equal(mock.tokenRequests.length, 1);
		assert.equal(pusher.errors.length, 1);
		assert.equal(pusher.errors[0].source, 'fcm-auth');
		assert.equal(mock.requests.length, 0);
	});

	it('retries the token request on server errors', async () => {
		let calls = 0;
		mock.respondToken = () => ++calls === 1 ? { status: 503, body: { error: 'unavailable' } } : null;
		createPusher();
		const [ result ] = await pusher.send('fcm', { token: 't' });
		assert.equal(result.ok, true);
		assert.equal(mock.tokenRequests.length, 2);
		assert.equal(pusher.errors.length, 1, 'the failed attempt is still reported');
	});

	it('uses fcm.projectId over the service account project', async () => {
		mock.respond = (r) => r.path === '/v1/projects/other-project/messages:send' ? { status: 200 } : fcmError(404, 'NOT_FOUND');
		createPusher({ projectId: 'other-project' });
		const [ result ] = await pusher.send('fcm', { token: 't' });
		assert.equal(result.ok, true);
	});
});
