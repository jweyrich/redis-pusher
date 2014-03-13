
function APNSMessage (data) {
	// identifier: [string] -- Unique identifier
	// device_token: [string] -- APNS device id
	// expires: [number] -- Seconds from now
	// badge: [number]
	// sound: [string]
	// alert: [string]
	// payload: [object]

	var parsed = {};
	if (data !== undefined && data !== null) {
		try {
			parsed = JSON.parse(data);
		} catch (exception) {
		}
	}

	this.identifier = parsed.identifier || undefined;
	this.device_token = parsed.device_token || undefined;
	this.expires = parsed.expires || 0;
	this.badge = parsed.badge || 0;
	this.sound = parsed.sound || undefined;
	this.alert = parsed.alert || undefined;
	this.payload = parsed.payload || {};
}

APNSMessage.prototype.clone = function (identifier, device_token) {
	var message = new APNSMessage();

	message.identifier = identifier;
	message.device_token = device_token;
	message.expires = this.expires;
	message.badge = this.badge;
	message.sound = this.sound;
	message.alert = this.alert;
	message.payload = this.payload;

	return message;
};

module.exports = APNSMessage;
