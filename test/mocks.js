'use strict';
//
// In-process mock APNS and FCM servers (HTTP/2 without TLS) plus matching
// credentials. They verify JWT signatures the same way the real services do,
// record every request, and let tests script the responses.
//

const crypto = require('node:crypto');
const http2 = require('node:http2');

function generateCredentials() {
	const ec = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
	const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
	return {
		apns: {
			key: ec.privateKey.export({ type: 'pkcs8', format: 'pem' }),
			publicKey: ec.publicKey,
			keyId: 'ABC123DEFG',
			teamId: 'DEF123GHIJ',
			topic: 'com.example.app'
		},
		fcm: {
			publicKey: rsa.publicKey,
			serviceAccount: {
				type: 'service_account',
				project_id: 'test-project',
				private_key_id: 'key-1',
				private_key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }),
				client_email: 'pusher@test-project.iam.gserviceaccount.com'
			}
		}
	};
}

// Returns the decoded { header, claims } if the JWT is signed by `publicKey`.
function verifyJWT(jwt, publicKey) {
	const parts = String(jwt).split('.');
	if (parts.length !== 3)
		return null;
	const decode = (part) => JSON.parse(Buffer.from(part, 'base64url').toString());
	const header = decode(parts[0]);
	const data = Buffer.from(parts[0] + '.' + parts[1]);
	const signature = Buffer.from(parts[2], 'base64url');
	const valid = header.alg === 'ES256'
		? crypto.verify('sha256', data, { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)
		: crypto.verify('sha256', data, publicKey, signature);
	return valid ? { header, claims: decode(parts[1]) } : null;
}

// Start an h2c server. `handler(request)` gets { method, path, headers, body }
// and returns (or resolves to) { status, headers, body } or { destroy: true }.
async function startServer(handler) {
	const server = http2.createServer();
	const sessions = new Set();
	const state = { active: 0, maxActive: 0 };

	server.on('session', (session) => {
		sessions.add(session);
		session.on('close', () => sessions.delete(session));
	});
	server.on('stream', (stream, headers) => {
		const chunks = [];
		state.active++;
		state.maxActive = Math.max(state.maxActive, state.active);
		stream.on('close', () => { state.active--; });
		stream.on('error', () => {});
		stream.on('data', (chunk) => chunks.push(chunk));
		stream.on('end', async () => {
			const request = {
				method: headers[':method'],
				path: headers[':path'],
				headers,
				body: Buffer.concat(chunks).toString()
			};
			const reply = await handler(request);
			if (stream.destroyed)
				return;
			if (reply.destroy)
				return stream.close(http2.constants.NGHTTP2_INTERNAL_ERROR);
			stream.respond(Object.assign({ ':status': reply.status || 200 }, reply.headers));
			stream.end(reply.body === undefined ? '' : typeof reply.body === 'string' ? reply.body : JSON.stringify(reply.body));
		});
	});

	await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
	return {
		url: 'http://127.0.0.1:' + server.address().port,
		state,
		// Drop every client connection but keep listening.
		dropConnections: () => {
			for (const session of sessions)
				session.destroy();
		},
		close: () => new Promise((resolve) => {
			for (const session of sessions)
				session.destroy();
			server.close(() => resolve());
		})
	};
}

//
// Mock APNS. `mock.respond(request)` can be replaced to script replies; by
// default every authorized request gets a 200 with an apns-id.
//
async function startMockAPNS(credentials) {
	let nextId = 1;
	const mock = {
		requests: [],
		respond: () => ({ status: 200 })
	};
	const server = await startServer(async (request) => {
		const token = (request.headers.authorization || '').replace(/^bearer /, '');
		const jwt = token && verifyJWT(token, credentials.publicKey);
		request.jwt = jwt;
		request.deviceToken = request.path.replace(/^\/3\/device\//, '');
		request.json = JSON.parse(request.body || '{}');
		mock.requests.push(request);

		const apnsId = 'apns-' + nextId++;
		if (!jwt || jwt.header.kid !== credentials.keyId || jwt.claims.iss !== credentials.teamId)
			return { status: 403, headers: { 'apns-id': apnsId }, body: { reason: 'InvalidProviderToken' } };

		const reply = await mock.respond(request);
		return Object.assign({}, reply, { headers: Object.assign({ 'apns-id': apnsId }, reply.headers) });
	});
	return Object.assign(mock, server);
}

//
// Mock FCM: serves both the OAuth token endpoint (/token) and the send
// endpoint. Access tokens are 'access-1', 'access-2', ...; `mock.revoke()`
// invalidates every token issued so far.
//
async function startMockFCM(credentials) {
	let issued = 0;
	let nextMessage = 1;
	const valid = new Set();
	const mock = {
		requests: [],
		tokenRequests: [],
		issued: [],       // Access tokens issued, in order.
		respond: () => ({ status: 200 }),
		respondToken: null,
		revoke: () => valid.clear()
	};
	const server = await startServer(async (request) => {
		if (request.path === '/token') {
			const form = new URLSearchParams(request.body);
			request.form = form;
			request.jwt = verifyJWT(form.get('assertion'), credentials.publicKey);
			mock.tokenRequests.push(request);
			// A scripted reply, or nothing to fall through to the default behaviour.
			const scripted = mock.respondToken && mock.respondToken(request);
			if (scripted)
				return scripted;
			if (form.get('grant_type') !== 'urn:ietf:params:oauth:grant-type:jwt-bearer' || !request.jwt)
				return { status: 400, body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' } };
			const accessToken = 'access-' + ++issued;
			valid.add(accessToken);
			mock.issued.push(accessToken);
			return { status: 200, body: { access_token: accessToken, expires_in: 3599, token_type: 'Bearer' } };
		}

		request.json = JSON.parse(request.body || '{}');
		request.accessToken = (request.headers.authorization || '').replace(/^Bearer /, '');
		mock.requests.push(request);
		if (!valid.has(request.accessToken))
			return { status: 401, body: { error: { code: 401, status: 'UNAUTHENTICATED', message: 'Request had invalid authentication credentials.' } } };

		const reply = await mock.respond(request);
		if (reply.status === undefined || reply.status === 200) {
			const projectId = credentials.serviceAccount.project_id;
			return { status: 200, body: { name: 'projects/' + projectId + '/messages/' + nextMessage++ } };
		}
		return reply;
	});
	return Object.assign(mock, server);
}

// An FCM error response in the v1 API format.
function fcmError(status, statusText, errorCode, message = statusText) {
	const details = errorCode
		? [ { '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode } ]
		: [];
	return { status, body: { error: { code: status, status: statusText, message, details } } };
}

// Options pointing a pusher at the mocks, with fast retries.
function apnsOptions(credentials, mock, extra) {
	const { key, keyId, teamId, topic } = credentials.apns;
	return Object.assign({ key, keyId, teamId, topic, url: mock.url, retryDelay: 5 }, extra);
}

function fcmOptions(credentials, mock, extra) {
	const serviceAccount = Object.assign({}, credentials.fcm.serviceAccount, { token_uri: mock.url + '/token' });
	return Object.assign({ serviceAccount, url: mock.url, retryDelay: 5 }, extra);
}

module.exports = {
	generateCredentials, verifyJWT, startMockAPNS, startMockFCM, fcmError, apnsOptions, fcmOptions
};
