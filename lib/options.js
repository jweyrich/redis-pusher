'use strict';

const fs = require('fs');
const { isPlainObject } = require('./util');
const { PLATFORMS, normalizePlatform } = require('./messages');

const DEFAULTS = {
	// Any object with console-like `log`, `warn` and `error` methods.
	// Defaults to silent; pass `console` to get the classic output.
	logger: null,

	redis: {
		host: '127.0.0.1',
		port: 6379,
		pass: '',
		options: {},           // Passed as-is to redis.createClient().
		// Either an array of channel names (the platform is guessed from the
		// name, see guessPlatform below) or an object mapping each channel to
		// its platform, e.g. { 'push:ios': 'apns', 'push:android': 'fcm' }.
		channels: [],
		failoverEnabled: false,
		lock: {
			keyPrefix: 'push_lock_',
			lockTimeout: 5000,   // Milliseconds.
			maxAttempts: 5
		}
	},

	// Set to `false` (or leave the credentials out) to disable APNS.
	apns: {
		// Token-based auth (recommended): a .p8 key from your Apple developer account.
		key: undefined,        // Path to the .p8 file, or its PEM contents.
		keyId: undefined,
		teamId: undefined,
		// Or certificate-based auth.
		certificate: undefined, // Path to a .p12 (PKCS #12) file, or its contents as a Buffer.
		passphrase: undefined,

		topic: undefined,      // Your app's bundle ID. Required with token-based auth.
		production: true,      // false => api.sandbox.push.apple.com
		url: undefined,        // Overrides the APNS server URL (e.g. for testing).
		port: 443,             // 443 or 2197.
		concurrency: 100,      // Max concurrent requests (HTTP/2 streams).
		requestTimeout: 10000, // Milliseconds.
		retries: 3,            // On 429/5xx/network errors.
		retryDelay: 500        // Initial backoff in milliseconds, doubled on each retry.
	},

	// Set to `false` (or leave the service account out) to disable FCM.
	fcm: {
		serviceAccount: undefined, // Path to the service account JSON key file, or its parsed contents.
		projectId: undefined,      // Defaults to the service account's project_id.
		url: 'https://fcm.googleapis.com', // Overrides the FCM server URL (e.g. for testing).
		concurrency: 100,
		requestTimeout: 10000,
		retries: 3,
		retryDelay: 500
	}
};

// Deep merge where plain objects are merged recursively and everything else
// (arrays, Buffers, functions, `false`, class instances such as `console`)
// replaces the target value.
function merge(target, source) {
	for (const key of Object.keys(source || {})) {
		const value = source[key];
		if (value === undefined)
			continue;
		if (isPlainObject(value))
			target[key] = merge(isPlainObject(target[key]) ? target[key] : {}, value);
		else
			target[key] = value;
	}
	return target;
}

// Backwards-compatible heuristic: classify a channel by keywords in its name.
function guessPlatform(channel) {
	const chan = channel.toLowerCase();
	if ([ 'fcm', 'gcm', 'android' ].some((word) => chan.indexOf(word) !== -1))
		return 'fcm';
	if ([ 'apns', 'ios', 'iphone', 'ipad' ].some((word) => chan.indexOf(word) !== -1))
		return 'apns';
	return undefined;
}

function normalizeChannels(channels, enabled) {
	const map = {};

	if (typeof channels === 'string')
		channels = [ channels ];

	if (Array.isArray(channels)) {
		for (const channel of channels) {
			const platform = guessPlatform(channel);
			if (!platform)
				throw new Error("Cannot tell which platform channel '" + channel + "' is for. " +
					"Use an object for `redis.channels`, e.g. { '" + channel + "': 'apns' }");
			map[channel] = platform;
		}
	} else if (isPlainObject(channels)) {
		for (const channel of Object.keys(channels)) {
			const platform = normalizePlatform(channels[channel]);
			if (PLATFORMS.indexOf(platform) === -1)
				throw new Error("Channel '" + channel + "' is mapped to unknown platform '" + channels[channel] + "'");
			map[channel] = platform;
		}
	} else {
		throw new TypeError('`redis.channels` must be an array of channel names or an object');
	}

	for (const channel of Object.keys(map)) {
		const platform = map[channel];
		if (!enabled[platform])
			throw new Error("Channel '" + channel + "' is for " + platform + ', but ' + platform + ' is not configured (' +
				(platform === 'apns' ? 'set apns.key/keyId/teamId or apns.certificate' : 'set fcm.serviceAccount') + ')');
	}

	return map;
}

function readFile(file, what) {
	try {
		return fs.readFileSync(file);
	} catch (err) {
		throw new Error('Unable to read ' + what + ' from ' + file + ': ' + err.message);
	}
}

function normalizeAPNS(apns) {
	// Legacy (binary protocol) settings: only the sandbox/production choice still applies.
	const legacyAddress = apns.gateway && apns.gateway.address;
	if (legacyAddress && /sandbox/.test(legacyAddress))
		apns.production = false;
	delete apns.gateway;
	delete apns.feedback;

	if (!apns.key && !apns.certificate)
		return false;

	if (apns.key) {
		// A PEM string/Buffer, or a path to the .p8 file.
		const pem = String(apns.key).indexOf('-----BEGIN') !== -1;
		apns.key = pem ? String(apns.key) : readFile(apns.key, 'apns.key').toString();
		if (!apns.keyId || !apns.teamId)
			throw new Error('apns.key requires apns.keyId and apns.teamId');
		if (!apns.topic)
			throw new Error("apns.topic (your app's bundle ID) is required with token-based auth (apns.key)");
	} else if (!Buffer.isBuffer(apns.certificate)) {
		apns.certificate = readFile(apns.certificate, 'apns.certificate');
	}
	return apns;
}

function normalizeFCM(fcm) {
	if (!fcm.serviceAccount)
		return false;

	let account = fcm.serviceAccount;
	if (typeof account === 'string' || Buffer.isBuffer(account)) {
		const text = String(account).trim().charAt(0) === '{'
			? String(account)
			: readFile(account, 'fcm.serviceAccount').toString();
		try {
			account = JSON.parse(text);
		} catch (err) {
			throw new Error('fcm.serviceAccount is not valid JSON: ' + err.message);
		}
	}
	if (!account || !account.client_email || !account.private_key)
		throw new Error('fcm.serviceAccount must be a service account key (with client_email and private_key)');
	if (!fcm.projectId && !account.project_id)
		throw new Error('fcm.projectId is required (the service account has no project_id)');
	fcm.serviceAccount = account;
	return fcm;
}

module.exports = function normalizeOptions(userOptions) {
	userOptions = userOptions || {};

	if (userOptions.gcm)
		throw new Error('GCM was shut down by Google and legacy server keys no longer work. ' +
			'Configure `fcm.serviceAccount` instead (see the README).');

	const options = merge(merge({}, DEFAULTS), userOptions);
	delete options.gcm;

	if (options.apns)
		options.apns = normalizeAPNS(options.apns);
	if (options.fcm)
		options.fcm = normalizeFCM(options.fcm);

	const enabled = { apns: !!options.apns, fcm: !!options.fcm };
	options.redis.channels = normalizeChannels(options.redis.channels, enabled);

	return options;
};

module.exports.DEFAULTS = DEFAULTS;
module.exports.guessPlatform = guessPlatform;
