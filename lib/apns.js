'use strict';
//
// APNS transport: Apple's HTTP/2 provider API.
// https://developer.apple.com/documentation/usernotifications/sending-notification-requests-to-apns
//

const crypto = require('crypto');
const tls = require('tls');
const Http2Client = require('./http2-client');
const { signJWT, withRetries, retryAfter, parseJSON } = require('./util');

const HOSTS = {
	production: 'https://api.push.apple.com',
	development: 'https://api.sandbox.push.apple.com'
};

// Apple rejects tokens older than an hour, and refreshing more than once
// every 20 minutes gets you TooManyProviderTokenUpdates.
const PROVIDER_TOKEN_TTL = 50 * 60 * 1000;

const RETRYABLE_STATUS = [ 429, 500, 503 ];

class APNSTransport {
	// `options` is the normalized `apns` section (see options.js).
	constructor(options, { logger, onError } = {}) {
		this.options = options;
		this.logger = logger;
		this.onError = onError || (() => {});
		this.providerToken = null;
		this.reported = new Set();

		const tlsOptions = {};
		if (options.key) {
			try {
				this.signingKey = crypto.createPrivateKey(options.key);
			} catch (err) {
				throw new Error('Invalid apns.key (expected the .p8 key from Apple): ' + err.message);
			}
		} else {
			tlsOptions.pfx = options.certificate;
			tlsOptions.passphrase = options.passphrase;
			// Fail now on a bad certificate/passphrase instead of on the first push.
			try {
				tls.createSecureContext(tlsOptions);
			} catch (err) {
				throw new Error('Invalid apns.certificate or apns.passphrase: ' + err.message);
			}
		}

		let origin = options.url || (options.production ? HOSTS.production : HOSTS.development);
		if (!options.url && options.port && options.port !== 443)
			origin += ':' + options.port;

		this.client = new Http2Client(origin, {
			tls: tlsOptions,
			concurrency: options.concurrency,
			requestTimeout: options.requestTimeout,
			logger,
			name: 'apns'
		});
	}

	// Resolves to one result per device token; never rejects.
	send(message) {
		return Promise.all(message.token.map((token) => this._sendOne(message, token)));
	}

	close() {
		return this.client.close();
	}

	_authorization(staleToken) {
		if (!this.signingKey)
			return undefined;
		const now = Date.now();
		const current = this.providerToken;
		const stale = current && current.value === staleToken;
		if (!current || stale || now - current.issuedAt > PROVIDER_TOKEN_TTL) {
			const value = signJWT(
				{ alg: 'ES256', kid: this.options.keyId },
				{ iss: this.options.teamId, iat: Math.floor(now / 1000) },
				this.signingKey);
			this.providerToken = { value, issuedAt: now };
		}
		return this.providerToken.value;
	}

	_sendOne(message, token) {
		const request = message.request(token, { topic: this.options.topic });
		let staleToken;

		return withRetries(async () => {
			const headers = Object.assign({}, request.headers);
			const providerToken = this._authorization(staleToken);
			if (providerToken)
				headers.authorization = 'bearer ' + providerToken;

			let response;
			try {
				response = await this.client.request({ path: request.path, headers, body: request.body });
			} catch (err) {
				return { platform: 'apns', recipient: token, ok: false, error: err.code || err.message, retryable: err.code !== 'ERR_CLIENT_CLOSED' };
			}

			const outcome = this._interpret(token, response);
			if (outcome.refreshAuth)
				staleToken = providerToken;
			return outcome;
		}, this.options);
	}

	_interpret(token, { status, headers, body }) {
		if (status === 200)
			return { platform: 'apns', recipient: token, ok: true, id: headers['apns-id'] };

		const reply = parseJSON(body) || {};
		const outcome = {
			platform: 'apns',
			recipient: token,
			ok: false,
			status,
			error: reply.reason || 'HTTP ' + status
		};
		if (headers['apns-id'])
			outcome.id = headers['apns-id'];

		if (status === 410) {
			// The token is no longer valid for this topic (app uninstalled, etc.).
			outcome.unregistered = true;
			if (reply.timestamp)
				outcome.time = new Date(reply.timestamp);
		} else if (reply.reason === 'ExpiredProviderToken') {
			outcome.refreshAuth = true;
			outcome.retryable = true;
			outcome.retryAfter = 0;
		} else if (RETRYABLE_STATUS.indexOf(status) !== -1) {
			outcome.retryable = true;
			outcome.retryAfter = retryAfter(headers);
		}

		// Credential problems affect every push: report each kind once.
		const credentialError = [ 'InvalidProviderToken', 'MissingProviderToken', 'BadCertificate',
			'BadCertificateEnvironment', 'MissingTopic', 'TopicDisallowed' ].indexOf(reply.reason) !== -1;
		if (credentialError && !this.reported.has(reply.reason)) {
			this.reported.add(reply.reason);
			this.onError(Object.assign(new Error('APNS rejected the credentials: ' + reply.reason), { source: 'apns' }));
		}

		return outcome;
	}
}

module.exports = APNSTransport;
module.exports.HOSTS = HOSTS;
