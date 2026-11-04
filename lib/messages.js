//
// Message types understood by redis-pusher.
//
// A message can be built from a JSON string (e.g. what arrives on a Redis
// channel) or from a plain object. Constructors throw on malformed JSON and
// `validate()` throws on missing/invalid fields, so callers always get an Error
// describing what went wrong instead of a silently dropped notification.
//

function parse(data) {
	if (typeof data === 'string' || Buffer.isBuffer(data))
		return JSON.parse(String(data)); // Throws SyntaxError on invalid JSON.
	if (data !== null && typeof data === 'object' && !Array.isArray(data))
		return data;
	throw new TypeError('A message must be a JSON string or an object');
}

// Copy only the fields that were actually provided, so the underlying push
// libraries keep their own defaults for anything the caller left out.
function assignDefined(target, source, fields) {
	fields.forEach(function (field) {
		if (source[field] !== undefined)
			target[field] = source[field];
	});
}

function isRecipientList(value) {
	if (typeof value === 'string')
		return value.length > 0;
	if (!Array.isArray(value) || value.length === 0)
		return false;
	return value.every(function (item) {
		return typeof item === 'string' && item.length > 0;
	});
}

function validateIdentifier(message) {
	var id = message.identifier;
	if (id !== undefined && typeof id !== 'string' && typeof id !== 'number')
		throw new TypeError(message.platform + ' message: `identifier` must be a string or a number');
}

//
// APNS
//
// identifier: [string]               -- Unique identifier. Required when the message is consumed from Redis.
// token: [string or array of string] -- Required. The APNS device token(s) of the recipient(s).
// expiry: [number]                   -- Seconds from now (not a timestamp).
// badge: [number]
// sound: [string]
// alert: [string or object]
// payload: [object]
// retryLimit: [number]
//
function APNSMessage(data) {
	var parsed = parse(data);
	assignDefined(this, parsed, [ 'identifier', 'token', 'badge', 'sound', 'alert', 'retryLimit' ]);
	this.payload = parsed.payload || {};
	// Convert seconds from now to the actual timestamp.
	if (parsed.expiry)
		this.expiry = Math.floor(Date.now() / 1000) + parsed.expiry;
}

// Non-enumerable so it is not copied into the outgoing notification.
Object.defineProperty(APNSMessage.prototype, 'platform', { value: 'apns' });

APNSMessage.prototype.recipients = function () {
	return this.token;
};

APNSMessage.prototype.validate = function () {
	validateIdentifier(this);
	if (!isRecipientList(this.token))
		throw new TypeError('apns message: `token` must be a non-empty string or array of strings');
	if (!Array.isArray(this.token))
		this.token = [ this.token ];
	return this;
};

//
// GCM
//
// identifier: [string]                        -- Unique identifier. Required when the message is consumed from Redis.
// registrationId: [string or array of string] -- Required. The GCM registration ID(s) of the recipient(s), up to 1000.
// collapseKey: [string]
// delayWhileIdle: [boolean]
// timeToLive: [number:0..2419200]
// data: [object]
//
function GCMMessage(data) {
	var parsed = parse(data);
	assignDefined(this, parsed, [ 'identifier', 'registrationId', 'collapseKey', 'delayWhileIdle', 'timeToLive', 'data' ]);
}

Object.defineProperty(GCMMessage.prototype, 'platform', { value: 'gcm' });

GCMMessage.prototype.recipients = function () {
	return this.registrationId;
};

GCMMessage.prototype.validate = function () {
	validateIdentifier(this);
	if (!isRecipientList(this.registrationId))
		throw new TypeError('gcm message: `registrationId` must be a non-empty string or array of strings');
	if (!Array.isArray(this.registrationId))
		this.registrationId = [ this.registrationId ];
	return this;
};

var types = {
	apns: APNSMessage,
	gcm: GCMMessage
};

// Build and validate a message for `platform` ('apns' or 'gcm').
// Throws if the platform is unknown or the message is invalid.
function create(platform, data) {
	var Type = types[platform];
	if (!Type)
		throw new Error('Unknown platform: ' + platform + " (expected 'apns' or 'gcm')");
	return new Type(data).validate();
}

module.exports.APNSMessage = APNSMessage;
module.exports.GCMMessage = GCMMessage;
module.exports.create = create;
module.exports.PLATFORMS = Object.keys(types);
