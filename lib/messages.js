
function APNSMessage (data) {
	// identifier: [string] -- Required. Unique identifier.
	// token: [string or array of string] -- Required. The APNS device token of a recipient device, or an array of them for sending to 1 or more (up to ???).
	// expiry: [number] -- Note that it expects seconds from now, not the actual timestamp.
	// badge: [number]
	// sound: [string]
	// alert: [string]
	// payload: [object]

	var parsed = {};
	if (data !== undefined && data !== null) {
		try {
			parsed = JSON.parse(data);
		} catch (exception) {
			console.error("Invalid JSON: " + data);
		}
	}

	this.identifier = parsed.identifier || undefined;
	this.token = parsed.token || undefined;
	this.expiry = parsed.expiry || 0;
	// Convert seconds from now to the actual timestamp.
	if (this.expiry)
		this.expiry = Math.floor(Date.now() / 1000) + this.expiry;
	this.badge = parsed.badge || undefined;
	this.sound = parsed.sound || undefined;
	this.alert = parsed.alert || undefined;
	this.payload = parsed.payload || {};
}

APNSMessage.prototype.isTokenValid = function (token) {
	var object = token;
	var isString = typeof object === 'string';
	var isArrayOfStrings = Array.isArray(object);
	var isValid = true;

	if (isArrayOfStrings) {
		for (o in object) {
			if (typeof o !== 'string') {
				console.error('APNSMessage has an invalid token: ' + o);
				isValid = false;
				break;
			}
		}
	}

	return isValid && (isString || isArrayOfStrings);
};

APNSMessage.prototype.compile = function () {
	var valid = this.isTokenValid(this.token);
	if (!valid)
		return null;

	// If this.token is not an Array, convert it to Array.
	if (!Array.isArray(this.token)) {
		this.token = [ this.token ];
	}

	return this;
};

function GCMMessage (data) {
	// identifier: [string] -- Required. Unique identifier.
	// registrationId: [string or array of string] -- Required. The GCM registration ID of a recipient device, or an array of them for sending to 1 or more devices (up to 1000). When you send a message to multiple registration IDs, that is called a multicast message.
	// collapseKey: [string] -- Optional. If there's an older message with the same collapseKey and registration ID, the older message will be discarded and the new one will take its place.
	// delayWhileIdle: [boolean] -- Optional. Default is false. If the device is connected but idle, the message will still be delivered right away unless the delay_while_idle flag is set to true. Otherwise, it will be stored in the GCM servers until the device is awake. 
	// timeToLive: [number:0..2419200] -- Optional. How long (in seconds) the message should be kept on GCM storage if the device is offline. Requests that don't contain this field default to the maximum period of 4 weeks. When a message times out, it will be discarded from the GCM storage.
	// data: [object] -- Optional. Custom payload.
	
	var parsed = {};
	if (data !== undefined && data !== null) {
		try {
			parsed = JSON.parse(data);
		} catch (exception) {
			console.error("Invalid JSON: " + data);
		}
	}

	this.identifier = parsed.identifier || undefined;
	this.registrationIds = parsed.registrationId || undefined;
	this.collapseKey = parsed.collapseKey || undefined;
	this.delayWhileIdle = parsed.delayWhileIdle || undefined;
	this.timeToLive = parsed.timeToLive || undefined;
	this.data = parsed.data || undefined;
}

GCMMessage.prototype.isRegistrationIdValid = function (registrationId) {
	var object = token;
	var isString = typeof object === 'string';
	var isArrayOfStrings = Array.isArray(object);
	var isValid = true;

	if (isArrayOfStrings) {
		for (o in object) {
			if (typeof o !== 'string') {
				console.error('GCMMessage has an invalid token: ' + o);
				isValid = false;
				break;
			}
		}
	}

	return isValid && (isString || isArrayOfStrings);
};

GCMMessage.prototype.compile = function () {
	var valid = this.isRegistrationIdValid(this.token);
	if (!valid)
		return null;

	// If this.registrationId is not an Array, convert it to Array.
	if (!Array.isArray(this.registrationId)) {
		this.registrationId = [ this.registrationId ];
	}

	return this;
};

module.exports.APNSMessage = APNSMessage;
module.exports.GCMMessage = GCMMessage;
