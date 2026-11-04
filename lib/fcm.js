'use strict';
//
// FCM transport: Firebase Cloud Messaging HTTP v1 API, authenticated with a
// Google service account (OAuth 2.0 JWT bearer flow).
// https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages/send
//

const crypto = require('crypto');
const Http2Client = require('./http2-client');
const { signJWT, withRetries, retryAfter, parseJSON } = require('./util');

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
// Refresh the access token this long before Google says it expires.
const EXPIRY_MARGIN = 5 * 60 * 1000;

class FCMTransport {
	// `options` is the normalized `fcm` section (see options.js).
	constructor(options, { logger, onError } = {}) {
		this.options = options;
		this.logger = logger;
		this.onError = onError || (() => {});

		const account = options.serviceAccount;
		this.account = account;
		this.projectId = options.projectId || account.project_id;
		try {
			this.signingKey = crypto.createPrivateKey(account.private_key);
		} catch (err) {
			throw new Error('Invalid private_key in fcm.serviceAccount: ' + err.message);
		}
		this.tokenUri = new URL(account.token_uri || DEFAULT_TOKEN_URI);
		this.accessToken = null;
		this.pendingToken = null;

		const api = new URL(options.url);
		this.sendPath = api.pathname.replace(/\/$/, '') +
			'/v1/projects/' + encodeURIComponent(this.projectId) + '/messages:send';

		const clientOptions = { concurrency: options.concurrency, requestTimeout: options.requestTimeout, logger };
		this.client = new Http2Client(api.origin, Object.assign({ name: 'fcm' }, clientOptions));
		this.authClient = new Http2Client(this.tokenUri.origin, Object.assign({ name: 'fcm-auth' }, clientOptions));
	}

	// Resolves to one result per registration token; never rejects.
	send(message) {
		return Promise.all(message.token.map((token) => this._sendOne(message, token)));
	}

	close() {
		return Promise.all([ this.client.close(), this.authClient.close() ]).then(() => {});
	}

	// Resolves to a valid OAuth access token, fetching a new one when needed.
	// Concurrent callers share one request. Passing the token that was just
	// rejected forces a refresh (once, however many requests saw it fail).
	_getAccessToken(staleToken) {
		const current = this.accessToken;
		if (current && current.value !== staleToken && Date.now() < current.expiresAt)
			return Promise.resolve(current.value);
		if (!this.pendingToken) {
			this.pendingToken = this._fetchAccessToken().then((token) => {
				this.pendingToken = null;
				this.accessToken = token;
				return token.value;
			}, (err) => {
				this.pendingToken = null;
				err.source = 'fcm-auth';
				this.onError(err);
				throw err;
			});
		}
		return this.pendingToken;
	}

	async _fetchAccessToken() {
		const now = Math.floor(Date.now() / 1000);
		const header = { alg: 'RS256', typ: 'JWT' };
		if (this.account.private_key_id)
			header.kid = this.account.private_key_id;
		const assertion = signJWT(header, {
			iss: this.account.client_email,
			scope: SCOPE,
			aud: this.tokenUri.href,
			iat: now,
			exp: now + 3600
		}, this.signingKey);

		let response;
		try {
			response = await this.authClient.request({
				path: this.tokenUri.pathname + this.tokenUri.search,
				headers: { 'content-type': 'application/x-www-form-urlencoded' },
				body: 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') +
					'&assertion=' + assertion
			});
		} catch (err) {
			throw Object.assign(new Error('Unable to reach the Google OAuth server: ' + err.message), { retryable: true });
		}

		const reply = parseJSON(response.body) || {};
		if (response.status !== 200 || !reply.access_token) {
			const detail = reply.error_description || reply.error || 'HTTP ' + response.status;
			throw Object.assign(new Error('Unable to get an FCM access token: ' + detail),
				{ status: response.status, retryable: response.status >= 500 });
		}
		const lifetime = (Number(reply.expires_in) || 3600) * 1000;
		return { value: reply.access_token, expiresAt: Date.now() + Math.max(lifetime - EXPIRY_MARGIN, lifetime / 2) };
	}

	_sendOne(message, token) {
		const body = JSON.stringify(message.request(token));
		let staleToken;

		return withRetries(async () => {
			let accessToken;
			try {
				accessToken = await this._getAccessToken(staleToken);
			} catch (err) {
				return { platform: 'fcm', recipient: token, ok: false, error: err.message, retryable: !!err.retryable };
			}

			let response;
			try {
				response = await this.client.request({
					path: this.sendPath,
					headers: { 'content-type': 'application/json', authorization: 'Bearer ' + accessToken },
					body
				});
			} catch (err) {
				return { platform: 'fcm', recipient: token, ok: false, error: err.code || err.message, retryable: err.code !== 'ERR_CLIENT_CLOSED' };
			}

			const outcome = this._interpret(token, response);
			if (outcome.refreshAuth)
				staleToken = accessToken;
			return outcome;
		}, this.options);
	}

	_interpret(token, { status, headers, body }) {
		const reply = parseJSON(body) || {};
		if (status === 200)
			return { platform: 'fcm', recipient: token, ok: true, id: reply.name };

		const error = reply.error || {};
		const detail = (error.details || []).filter((d) => d && d.errorCode)[0];
		const code = detail ? detail.errorCode : (error.status || 'HTTP ' + status);
		const outcome = { platform: 'fcm', recipient: token, ok: false, status, error: code };
		if (error.message)
			outcome.message = error.message;

		if (code === 'UNREGISTERED') {
			// The app was uninstalled or the token expired.
			outcome.unregistered = true;
		} else if (status === 401 && code !== 'THIRD_PARTY_AUTH_ERROR') {
			outcome.refreshAuth = true;
			outcome.retryable = true;
			outcome.retryAfter = 0;
		} else if (status === 429 || status >= 500) {
			outcome.retryable = true;
			outcome.retryAfter = retryAfter(headers);
		}
		return outcome;
	}
}

module.exports = FCMTransport;
