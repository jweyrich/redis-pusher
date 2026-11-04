'use strict';
//
// Message types understood by redis-pusher.
//
// A message can be built from a JSON string (e.g. what arrives on a Redis
// channel) or from a plain object. Constructors throw on malformed JSON and
// `validate()` throws on missing/invalid fields, so callers always get an Error
// describing what went wrong instead of a silently dropped notification.
//

const { isPlainObject } = require('./util');

const APNS_MAX_PAYLOAD = 4096;
const FCM_MAX_TTL = 2419200; // 4 weeks, in seconds.

function parse(data) {
	if (typeof data === 'string' || Buffer.isBuffer(data))
		return JSON.parse(String(data)); // Throws SyntaxError on invalid JSON.
	if (data !== null && typeof data === 'object' && !Array.isArray(data))
		return data;
	throw new TypeError('A message must be a JSON string or an object');
}

// Copy only the fields that were actually provided.
function assignDefined(target, source, fields) {
	for (const field of fields) {
		if (source[field] !== undefined)
			target[field] = source[field];
	}
}

function toList(value, pattern) {
	const list = Array.isArray(value) ? value : [ value ];
	const valid = list.length > 0 && list.every((item) => typeof item === 'string' && pattern.test(item));
	return valid ? list : null;
}

function check(condition, platform, text) {
	if (!condition)
		throw new TypeError(platform + ' message: ' + text);
}

function validateIdentifier(message) {
	const id = message.identifier;
	check(id === undefined || typeof id === 'string' || typeof id === 'number',
		message.platform, '`identifier` must be a string or a number');
}

const TYPE_CHECKS = {
	string: (value) => typeof value === 'string',
	boolean: (value) => typeof value === 'boolean',
	object: isPlainObject
};

// Check optional fields against one or more types. Mirrors the JSON schemas
// in ../schemas (test/schemas.test.js keeps them in sync).
function checkTypes(message, types, fields) {
	for (const field of fields) {
		const value = message[field];
		check(value === undefined || types.some((type) => TYPE_CHECKS[type](value)),
			message.platform, '`' + field + '` must be ' + types.map((type) => (type === 'object' ? 'an ' : 'a ') + type).join(' or '));
	}
}

//
// APNS (HTTP/2 provider API)
//
// identifier: [string]                -- Unique identifier. Required when the message is consumed from Redis.
// token: [string or array of string]  -- Required. Hex device token(s).
// alert: [string or object]
// badge: [number]
// sound: [string or object]
// category, threadId: [string]
// contentAvailable, mutableContent: [boolean]
// payload: [object]                   -- Custom keys, placed next to `aps`.
// aps: [object]                       -- Extra `aps` keys (e.g. 'interruption-level').
// expiry: [number]                    -- Seconds from now. 0 means "deliver once, don't store".
// priority: [10, 5 or 1]
// pushType: [string]                  -- Default: 'background' for silent pushes, else 'alert'.
// topic: [string]                     -- Overrides `apns.topic` (the app's bundle ID).
// collapseId: [string]
//
class APNSMessage {
	constructor(data) {
		const parsed = parse(data);
		assignDefined(this, parsed, [
			'identifier', 'token', 'alert', 'badge', 'sound', 'category', 'threadId', 'contentAvailable',
			'mutableContent', 'aps', 'priority', 'pushType', 'topic', 'collapseId'
		]);
		this.payload = parsed.payload || {};
		// Convert seconds from now to the actual timestamp.
		if (parsed.expiry !== undefined) {
			check(Number.isInteger(parsed.expiry) && parsed.expiry >= 0,
				'apns', '`expiry` must be a whole number of seconds (0 or more)');
			this.expiry = parsed.expiry === 0 ? 0 : Math.floor(Date.now() / 1000) + parsed.expiry;
		}
	}

	recipients() {
		return this.token;
	}

	validate() {
		validateIdentifier(this);
		// The token ends up in the request path, so only accept hex.
		const tokens = toList(this.token, /^[0-9a-fA-F]+$/);
		check(tokens, 'apns', '`token` must be a hex string or a non-empty array of hex strings');
		this.token = tokens;
		checkTypes(this, [ 'string', 'object' ], [ 'alert', 'sound' ]);
		checkTypes(this, [ 'string' ], [ 'category', 'threadId', 'pushType', 'topic', 'collapseId' ]);
		checkTypes(this, [ 'boolean' ], [ 'contentAvailable', 'mutableContent' ]);
		checkTypes(this, [ 'object' ], [ 'payload', 'aps' ]);
		check(this.badge === undefined || (Number.isInteger(this.badge) && this.badge >= 0),
			'apns', '`badge` must be a whole number (0 or more)');
		check(this.priority === undefined || [ 10, 5, 1 ].indexOf(this.priority) !== -1,
			'apns', '`priority` must be 10, 5 or 1');
		const size = Buffer.byteLength(JSON.stringify(this.body()));
		check(size <= APNS_MAX_PAYLOAD, 'apns', 'payload is ' + size + ' bytes, the limit is ' + APNS_MAX_PAYLOAD);
		return this;
	}

	body() {
		const aps = Object.assign({}, this.aps);
		if (this.alert !== undefined) aps.alert = this.alert;
		if (this.badge !== undefined) aps.badge = this.badge;
		if (this.sound !== undefined) aps.sound = this.sound;
		if (this.category !== undefined) aps.category = this.category;
		if (this.threadId !== undefined) aps['thread-id'] = this.threadId;
		if (this.contentAvailable) aps['content-available'] = 1;
		if (this.mutableContent) aps['mutable-content'] = 1;
		return Object.assign({}, this.payload, { aps });
	}

	// The HTTP/2 request for one device token.
	request(token, defaults = {}) {
		const silent = this.alert === undefined && this.badge === undefined && this.sound === undefined;
		const pushType = this.pushType || (silent && this.contentAvailable ? 'background' : 'alert');
		const headers = {
			'apns-push-type': pushType,
			'apns-priority': String(this.priority !== undefined ? this.priority : (pushType === 'background' ? 5 : 10))
		};
		const topic = this.topic || defaults.topic;
		if (topic) headers['apns-topic'] = topic;
		if (this.expiry !== undefined) headers['apns-expiration'] = String(this.expiry);
		if (this.collapseId !== undefined) headers['apns-collapse-id'] = String(this.collapseId);
		return { path: '/3/device/' + token, headers, body: JSON.stringify(this.body()) };
	}
}

// Non-enumerable so it is not part of the message's own fields.
Object.defineProperty(APNSMessage.prototype, 'platform', { value: 'apns' });

//
// FCM (HTTP v1 API)
//
// identifier: [string]                 -- Unique identifier. Required when the message is consumed from Redis.
// token: [string or array of string]   -- Required. FCM registration token(s). `registrationId` is accepted too.
// notification: [object]               -- { title, body, image }
// data: [object]                       -- Custom data. Non-string values are JSON-encoded (FCM only accepts strings).
// collapseKey: [string]                -- android.collapse_key
// timeToLive: [number:0..2419200]      -- Seconds. android.ttl
// priority: ['high' or 'normal']       -- android.priority
// android, apns, webpush, fcmOptions: [object] -- Passed through to the FCM message as-is.
//
class FCMMessage {
	constructor(data) {
		const parsed = parse(data);
		assignDefined(this, parsed, [
			'identifier', 'token', 'notification', 'data', 'collapseKey', 'timeToLive', 'priority',
			'android', 'apns', 'webpush', 'fcmOptions'
		]);
		// Legacy GCM field name.
		if (this.token === undefined && parsed.registrationId !== undefined)
			this.token = parsed.registrationId;
	}

	recipients() {
		return this.token;
	}

	validate() {
		validateIdentifier(this);
		const tokens = toList(this.token, /\S/);
		check(tokens, 'fcm', '`token` (or `registrationId`) must be a non-empty string or array of strings');
		this.token = tokens;
		checkTypes(this, [ 'object' ], [ 'notification', 'data', 'android', 'apns', 'webpush', 'fcmOptions' ]);
		checkTypes(this, [ 'string' ], [ 'collapseKey' ]);
		if (this.notification) {
			for (const key of Object.keys(this.notification)) {
				check([ 'title', 'body', 'image' ].indexOf(key) !== -1,
					'fcm', '`notification` only accepts title, body and image (use `android`, `apns` or `webpush` for more)');
				check(typeof this.notification[key] === 'string', 'fcm', '`notification.' + key + '` must be a string');
			}
		}
		check(this.timeToLive === undefined ||
			(typeof this.timeToLive === 'number' && this.timeToLive >= 0 && this.timeToLive <= FCM_MAX_TTL),
			'fcm', '`timeToLive` must be a number of seconds between 0 and ' + FCM_MAX_TTL);
		check(this.priority === undefined || this.priority === 'high' || this.priority === 'normal',
			'fcm', "`priority` must be 'high' or 'normal'");
		return this;
	}

	// The FCM v1 request body for one registration token.
	request(token) {
		const message = { token };
		if (this.notification) message.notification = this.notification;
		if (this.data) {
			message.data = {};
			for (const key of Object.keys(this.data)) {
				const value = this.data[key];
				message.data[key] = typeof value === 'string' ? value : JSON.stringify(value);
			}
		}
		const android = Object.assign({}, this.android);
		if (this.collapseKey !== undefined) android.collapse_key = String(this.collapseKey);
		if (this.timeToLive !== undefined) android.ttl = this.timeToLive + 's';
		if (this.priority !== undefined) android.priority = this.priority.toUpperCase();
		if (Object.keys(android).length > 0) message.android = android;
		if (this.apns) message.apns = this.apns;
		if (this.webpush) message.webpush = this.webpush;
		if (this.fcmOptions) message.fcm_options = this.fcmOptions;
		return { message };
	}
}

Object.defineProperty(FCMMessage.prototype, 'platform', { value: 'fcm' });

const types = {
	apns: APNSMessage,
	fcm: FCMMessage
};

// 'gcm' is accepted as an alias for 'fcm'.
function normalizePlatform(platform) {
	return platform === 'gcm' ? 'fcm' : platform;
}

// Build and validate a message for `platform` ('apns' or 'fcm').
// Throws if the platform is unknown or the message is invalid.
function create(platform, data) {
	const Type = types[normalizePlatform(platform)];
	if (!Type)
		throw new Error('Unknown platform: ' + platform + " (expected 'apns' or 'fcm')");
	return new Type(data).validate();
}

module.exports = {
	APNSMessage,
	FCMMessage,
	GCMMessage: FCMMessage,
	create,
	normalizePlatform,
	PLATFORMS: Object.keys(types)
};
