var events = require('events')
	, util = require('util')
	, redis = require('redis')
	, apn = require('apn')
	, notify = require('push-notify')
	, RedisLockingWorker = require('redis-locking-worker')
	, messages = require('./messages')
	, normalizeOptions = require('./options');

function noop() {}

var SILENT_LOGGER = { log: noop, warn: noop, error: noop };

//
// Pusher
//
// Consumes messages published on Redis channels and delivers them as push
// notifications via APNS and/or GCM. It can also be used without Redis by
// calling `send()` directly.
//
// Events:
//   'ready'               ()                         Subscribed to all configured channels.
//   'message'             (message, channel)         A valid message was received from Redis.
//   'invalid'             (error, channel, raw)      A message received from Redis was rejected.
//   'sent'                (message)                  A message was handed to the APNS/GCM sender.
//   'transmitted'         (info)                     Delivered to a device. info: { platform, recipient, notification|result }
//   'transmissionError'   (info)                     Rejected for a device. info: { platform, recipient, error, notification|result }
//   'registrationUpdated' (info)                     GCM canonical ID. info: { platform, recipient, newRecipient, result }
//   'feedback'            (devices)                  APNS feedback. devices: [ { token, time } ]
//   'error'               (error)                    Connection/protocol errors. `error.source` says where it came from.
//
function Pusher(options) {
	if (!(this instanceof Pusher))
		return new Pusher(options);

	events.EventEmitter.call(this);

	this.options = normalizeOptions(options);
	this.logger = this.options.logger || SILENT_LOGGER;
	this.running = false;

	this._client = null;
	this._subscriber = null;
	this._senders = {};
	this._feedback = null;
}

util.inherits(Pusher, events.EventEmitter);

//
// Public API
//

// Connect to Redis, subscribe to the configured channels and start polling
// the APNS feedback service. `callback(err)` is called once subscribed.
Pusher.prototype.start = function (callback) {
	var self = this;
	var channels = Object.keys(this.options.redis.channels);
	callback = once(callback || noop);

	if (this.running) {
		process.nextTick(function () { callback(new Error('Pusher is already running')); });
		return this;
	}
	if (channels.length === 0) {
		process.nextTick(function () { callback(new Error('No channels configured (redis.channels)')); });
		return this;
	}

	this.running = true;
	this._client = this._createRedisClient('redis-client');
	this._subscriber = this._createRedisClient('redis-subscriber');

	var pending = {};
	channels.forEach(function (channel) { pending[channel] = true; });

	this._subscriber.on('subscribe', function (channel, count) {
		self.logger.log("[redis-subscriber] Subscribed to '%s', %d total subscriptions", channel, count);
		if (!pending[channel])
			return; // Resubscription after a reconnect.
		delete pending[channel];
		if (Object.keys(pending).length === 0) {
			self.emit('ready');
			callback(null);
		}
	}).on('unsubscribe', function (channel, count) {
		self.logger.log("[redis-subscriber] Unsubscribed from '%s', %d total subscriptions", channel, count);
	}).on('message', function (channel, raw) {
		self._onRedisMessage(channel, raw);
	});

	// The client queues this until connected, and resubscribes on reconnect.
	// Note: redis@0.8 only expands an array argument when a callback is given;
	// without it, the channels would be joined into a single 'a,b' channel.
	this._subscriber.subscribe(channels, noop);

	if (this.options.apns && this.options.apns.feedback.enabled)
		this._feedback = this._createFeedback();

	return this;
};

// Unsubscribe, close every connection and stop polling the feedback service.
// `callback(err)` is called once the Redis connections are closed.
Pusher.prototype.stop = function (callback) {
	var self = this;
	callback = once(callback || noop);

	if (this._feedback) {
		this._feedback.cancel();
		this._feedback = null;
	}

	var apnsSender = this._senders.apns;
	if (apnsSender && apnsSender.connection) {
		apnsSender.connection.sockets.forEach(function (socket) { socket.end(); });
	}
	this._senders = {};

	if (!this.running) {
		process.nextTick(function () { callback(null); });
		return this;
	}
	this.running = false;

	var clients = [ this._subscriber, this._client ];
	var remaining = clients.length;
	this._subscriber.unsubscribe();
	clients.forEach(function (client) {
		client.quit(function (err) {
			if (err)
				return callback(err);
			if (--remaining === 0)
				callback(null);
		});
	});
	this._client = null;
	this._subscriber = null;

	return this;
};

// Send a notification right away, without going through Redis or locking.
// `data` is a JSON string, a plain object, or an APNSMessage/GCMMessage.
// Throws if the message is invalid or the platform is not configured.
// Delivery results are reported through the 'transmitted' and
// 'transmissionError' events. Returns the validated message.
Pusher.prototype.send = function (platform, data) {
	var message = (data instanceof messages.APNSMessage || data instanceof messages.GCMMessage)
		? data.validate()
		: messages.create(platform, data);
	if (message.platform !== platform)
		throw new Error('Cannot send a ' + message.platform + ' message via ' + platform);
	this._dispatch(message);
	return message;
};

//
// Redis
//

Pusher.prototype._createRedisClient = function (name) {
	var self = this;
	var opts = this.options.redis;
	var client = redis.createClient(opts.port, opts.host, opts.options);
	if (opts.pass)
		client.auth(opts.pass);
	client.on('error', function (err) {
		self._error(name, err);
	}).on('connect', function () {
		self.logger.log('[%s] Connected', name);
	}).on('end', function () {
		self.logger.log('[%s] Connection closed', name);
	});
	return client;
};

Pusher.prototype._onRedisMessage = function (channel, raw) {
	var platform = this.options.redis.channels[channel];
	var message;

	this.logger.log("[redis-subscriber] Received message on '%s': '%s'", channel, raw);

	try {
		message = messages.create(platform, raw);
		if (message.identifier === undefined || message.identifier === '')
			throw new TypeError(platform + ' message: `identifier` is required for messages published via Redis');
	} catch (err) {
		this.logger.warn("[redis-subscriber] Invalid message on '%s': %s", channel, err.message);
		this.emit('invalid', err, channel, raw);
		return;
	}

	this.emit('message', message, channel);
	this._lockAndDispatch(message);
};

// Make sure only one instance sharing the same lock prefix sends a message.
Pusher.prototype._lockAndDispatch = function (message) {
	var self = this;
	var opts = this.options.redis;
	var worker = new RedisLockingWorker({
		client: this._client,
		lockKey: opts.lock.keyPrefix + message.identifier,
		statusLevel: RedisLockingWorker.StatusLevels.Verbose,
		lockTimeout: opts.lock.lockTimeout,
		maxAttempts: opts.lock.maxAttempts
	});

	worker.on('acquired', function (lastAttempt) {
		self.logger.log('[redis-lock] Acquired lock %s', worker.lockKey);
		try {
			self._dispatch(message);
		} catch (err) {
			self._error(message.platform, err);
		}
		worker.done(opts.failoverEnabled ? lastAttempt : true);
	}).on('locked', function () {
		self.logger.log('[redis-lock] Someone else acquired the lock %s', worker.lockKey);
	}).on('max-attempts', function () {
		self.logger.warn('[redis-lock] Giving up on lock %s after %d attempts', worker.lockKey, opts.lock.maxAttempts);
	}).on('status', function (status) {
		self.logger.log('[redis-lock] %s: %s', worker.lockKey, status);
	}).on('error', function (err) {
		self._error('redis-lock', err);
	});

	worker.acquire();
};

//
// Delivery
//

Pusher.prototype._dispatch = function (message) {
	var sender = this._sender(message.platform);
	this.logger.log("[%s] Sending notification '%s' to device(s) [ '%s' ]",
		message.platform, message.identifier, message.recipients().join("', '"));
	sender.send(message);
	this.emit('sent', message);
};

Pusher.prototype._sender = function (platform) {
	if (!this.options[platform])
		throw new Error(platform + ' is not configured');
	if (!this._senders[platform])
		this._senders[platform] = platform === 'apns' ? this._createAPNSSender() : this._createGCMSender();
	return this._senders[platform];
};

function apnsCredentials(apnsOptions, target) {
	if (Buffer.isBuffer(apnsOptions.certificate))
		target.pfxData = apnsOptions.certificate;
	else
		target.pfx = apnsOptions.certificate;
	target.passphrase = apnsOptions.passphrase;
	return target;
}

Pusher.prototype._createAPNSSender = function () {
	var self = this;
	var gateway = this.options.apns.gateway;
	var connectionOptions = apnsCredentials(this.options.apns, {});

	// Everything except `address` is passed straight to apn.Connection.
	Object.keys(gateway).forEach(function (key) {
		if (key !== 'address')
			connectionOptions[key] = gateway[key];
	});
	connectionOptions.gateway = gateway.address;

	var sender = new notify.apn.Sender(connectionOptions);
	sender.on('error', function (err) {
		self._error('apns-gateway', err);
	}).on('socketError', function (err) {
		self._error('apns-gateway', err);
	}).on('timeout', function () {
		self.logger.log('[apns-gateway] Idle connection timed out');
	}).on('connected', function (count) {
		self.logger.log('[apns-gateway] Connected, %d total sockets', count);
	}).on('disconnected', function (count) {
		self.logger.log('[apns-gateway] Disconnected, %d total sockets', count);
	}).on('transmitted', function (notification, device) {
		self.logger.log("[apns-gateway] Transmitted to device '%s'", device);
		self.emit('transmitted', { platform: 'apns', recipient: String(device), notification: notification });
	}).on('transmissionError', function (code, notification, device) {
		self.logger.error("[apns-gateway] Transmission error (code %d) for recipient '%s'", code, device);
		self.emit('transmissionError', {
			platform: 'apns',
			recipient: device === undefined ? undefined : String(device),
			error: code,
			notification: notification
		});
	});
	return sender;
};

Pusher.prototype._createGCMSender = function () {
	var self = this;
	var sender = new notify.gcm.Sender(this.options.gcm.options);
	sender.on('error', function (err) {
		self._error('gcm-sender', err);
	}).on('transmitted', function (result, registrationId) {
		self.logger.log("[gcm-sender] Transmitted to device '%s'", registrationId);
		self.emit('transmitted', { platform: 'gcm', recipient: registrationId, result: result });
	}).on('transmissionError', function (error, registrationId) {
		self.logger.error("[gcm-sender] Transmission error (%s) for recipient '%s'", error, registrationId);
		self.emit('transmissionError', { platform: 'gcm', recipient: registrationId, error: error });
	}).on('updated', function (result, registrationId) {
		self.logger.log("[gcm-sender] Registration ID needs to be updated: '%s'", registrationId);
		self.emit('registrationUpdated', {
			platform: 'gcm',
			recipient: registrationId,
			newRecipient: result.registration_id,
			result: result
		});
	});
	return sender;
};

Pusher.prototype._createFeedback = function () {
	var self = this;
	var opts = this.options.apns.feedback;
	var feedback = new apn.Feedback(apnsCredentials(this.options.apns, {
		address: opts.address,
		interval: opts.interval,
		batchFeedback: true
	}));

	feedback.on('error', function (err) {
		// Usually a certificate loading problem; this is unlikely to recover.
		self._error('apns-feedback', err);
	}).on('feedbackError', function (err) {
		// Socket/processing errors; node-apn retries on the next interval.
		self._error('apns-feedback', err || new Error('APNS feedback request failed'));
	}).on('feedback', function (items) {
		if (!items || items.length === 0)
			return;
		var devices = items.map(function (item) {
			return { token: String(item.device), time: new Date(item.time * 1000) };
		});
		self.logger.log('[apns-feedback] %d device(s) reported as unreachable', devices.length);
		self.emit('feedback', devices);
	});
	return feedback;
};

//
// Helpers
//

Pusher.prototype._error = function (source, err) {
	if (!(err instanceof Error))
		err = new Error(String(err));
	err.source = source;
	this.logger.error('[%s] %s', source, err.message || err);
	this.emit('error', err);
};

function once(fn) {
	var called = false;
	return function () {
		if (called)
			return;
		called = true;
		fn.apply(this, arguments);
	};
}

module.exports = Pusher;
