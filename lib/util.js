'use strict';

const crypto = require('crypto');

function isPlainObject(value) {
	if (value === null || typeof value !== 'object')
		return false;
	const proto = Object.getPrototypeOf(value);
	return proto === Object.prototype || proto === null;
}

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Sign a compact JWS/JWT. `alg` is 'ES256' (APNS) or 'RS256' (Google OAuth).
function signJWT(header, claims, key) {
	const encode = (object) => Buffer.from(JSON.stringify(object)).toString('base64url');
	const input = encode(header) + '.' + encode(claims);
	const signature = header.alg === 'ES256'
		? crypto.sign('sha256', Buffer.from(input), { key, dsaEncoding: 'ieee-p1363' })
		: crypto.sign('sha256', Buffer.from(input), key);
	return input + '.' + signature.toString('base64url');
}

// Run `attempt(n)` until it succeeds, fails permanently or runs out of
// retries. `attempt` resolves to an outcome: { ok, retryable, retryAfter, ... }.
async function withRetries(attempt, { retries, retryDelay }) {
	for (let n = 0; ; n++) {
		const outcome = await attempt(n);
		if (outcome.ok || !outcome.retryable || n >= retries) {
			delete outcome.retryable;
			delete outcome.retryAfter;
			delete outcome.refreshAuth;
			return outcome;
		}
		const backoff = retryDelay * Math.pow(2, n);
		await delay(outcome.retryAfter !== undefined ? outcome.retryAfter : backoff);
	}
}

// Parse a Retry-After header (seconds) into milliseconds, capped at a minute.
function retryAfter(headers) {
	const seconds = Number(headers && headers['retry-after']);
	return Number.isFinite(seconds) && seconds >= 0 ? Math.min(seconds, 60) * 1000 : undefined;
}

function parseJSON(text) {
	try {
		return JSON.parse(text);
	} catch (err) {
		return undefined;
	}
}

module.exports = { isPlainObject, delay, signJWT, withRetries, retryAfter, parseJSON };
