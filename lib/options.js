var _ = require('lodash');

var PLATFORMS = require('./messages').PLATFORMS;

var DEFAULTS = {
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
		// its platform, e.g. { 'push:ios': 'apns', 'push:android': 'gcm' }.
		channels: [],
		failoverEnabled: false,
		lock: {
			keyPrefix: 'push_lock_',
			lockTimeout: 5000,   // Milliseconds.
			maxAttempts: 5
		}
	},

	// Set to `false` (or omit `certificate`) to disable APNS.
	apns: {
		certificate: undefined, // Path to a .p12 (PKCS #12) file, or its contents as a Buffer.
		passphrase: undefined,
		gateway: {
			address: 'gateway.push.apple.com', // Use gateway.sandbox.push.apple.com for development.
			connectionTimeout: 1000 * 240
		},
		feedback: {
			enabled: true,
			address: 'feedback.push.apple.com', // Use feedback.sandbox.push.apple.com for development.
			interval: 300        // Polling interval in seconds.
		}
	},

	// Set to `false` (or omit `options.key`) to disable GCM.
	gcm: {
		options: {
			key: undefined,      // GCM API key.
			retries: 3
		}
	}
};

// Deep merge where plain objects are merged recursively and everything else
// (arrays, Buffers, functions, `false`, class instances such as `console`)
// replaces the target value.
function merge(target, source) {
	Object.keys(source || {}).forEach(function (key) {
		var value = source[key];
		if (value === undefined)
			return;
		if (_.isPlainObject(value))
			target[key] = merge(_.isPlainObject(target[key]) ? target[key] : {}, value);
		else
			target[key] = value;
	});
	return target;
}

// Backwards-compatible heuristic: classify a channel by keywords in its name.
function guessPlatform(channel) {
	var chan = channel.toLowerCase();
	if (chan.indexOf('gcm') !== -1 || chan.indexOf('android') !== -1)
		return 'gcm';
	if (chan.indexOf('apns') !== -1 || chan.indexOf('ios') !== -1 ||
		chan.indexOf('iphone') !== -1 || chan.indexOf('ipad') !== -1)
		return 'apns';
	return undefined;
}

function normalizeChannels(channels, enabled) {
	var map = {};

	if (typeof channels === 'string')
		channels = [ channels ];

	if (Array.isArray(channels)) {
		channels.forEach(function (channel) {
			var platform = guessPlatform(channel);
			if (!platform)
				throw new Error("Cannot tell which platform channel '" + channel + "' is for. " +
					"Use an object for `redis.channels`, e.g. { '" + channel + "': 'apns' }");
			map[channel] = platform;
		});
	} else if (_.isPlainObject(channels)) {
		Object.keys(channels).forEach(function (channel) {
			var platform = channels[channel];
			if (PLATFORMS.indexOf(platform) === -1)
				throw new Error("Channel '" + channel + "' is mapped to unknown platform '" + platform + "'");
			map[channel] = platform;
		});
	} else {
		throw new TypeError('`redis.channels` must be an array of channel names or an object');
	}

	Object.keys(map).forEach(function (channel) {
		if (!enabled[map[channel]])
			throw new Error("Channel '" + channel + "' is for " + map[channel] + ', but ' + map[channel] +
				' is not configured (' + (map[channel] === 'apns' ? 'apns.certificate' : 'gcm.options.key') + ' is missing)');
	});

	return map;
}

module.exports = function normalizeOptions(userOptions) {
	var options = merge(merge({}, DEFAULTS), userOptions);

	if (options.apns && !options.apns.certificate)
		options.apns = false;
	if (options.gcm && !(options.gcm.options && options.gcm.options.key))
		options.gcm = false;

	var enabled = { apns: !!options.apns, gcm: !!options.gcm };
	options.redis.channels = normalizeChannels(options.redis.channels, enabled);

	return options;
};

module.exports.DEFAULTS = DEFAULTS;
module.exports.guessPlatform = guessPlatform;
