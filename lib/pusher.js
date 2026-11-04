'use strict';

const EventEmitter = require('events');
const redis = require('redis');
const RedisLockingWorker = require('redis-locking-worker');
const messages = require('./messages');
const normalizeOptions = require('./options');
const APNSTransport = require('./apns');
const FCMTransport = require('./fcm');

const noop = () => {};
const SILENT_LOGGER = { log: noop, warn: noop, error: noop };
const TRANSPORTS = { apns: APNSTransport, fcm: FCMTransport };

//
// Pusher
//
// Consumes messages published on Redis channels and delivers them as push
// notifications via APNS and/or FCM. It can also be used without Redis by
// calling `send()` directly.
//
// Events:
//   'ready'             ()                     Subscribed to all configured channels.
//   'message'           (message, channel)     A valid message was received from Redis.
//   'invalid'           (error, channel, raw)  A message received from Redis was rejected.
//   'sent'              (message, results)     Delivery was attempted for every recipient of a message.
//   'transmitted'       (result)               Accepted for a device:  { platform, recipient, ok: true, id }
//   'transmissionError' (result)               Rejected for a device:  { platform, recipient, ok: false, error, status, ... }
//   'unregistered'      (result)               The device token is no longer valid; stop sending to it.
//   'error'             (error)                Connection/credential errors. `error.source` says where it came from.
//
class Pusher extends EventEmitter {
	constructor(options) {
		super();
		this.options = normalizeOptions(options);
		this.logger = this.options.logger || SILENT_LOGGER;
		this.running = false;

		this._client = null;
		this._subscriber = null;
		this._transports = {};

		// Load and check credentials now rather than on the first push.
		for (const platform of messages.PLATFORMS) {
			if (this.options[platform])
				this._transport(platform);
		}
	}

	//
	// Public API
	//

	// Connect to Redis and subscribe to the configured channels.
	// `callback(err)` is called once subscribed.
	start(callback) {
		callback = once(callback || noop);
		const channels = Object.keys(this.options.redis.channels);

		if (this.running) {
			process.nextTick(callback, new Error('Pusher is already running'));
			return this;
		}
		if (channels.length === 0) {
			process.nextTick(callback, new Error('No channels configured (redis.channels)'));
			return this;
		}

		this.running = true;
		this._client = this._createRedisClient('redis-client');
		this._subscriber = this._createRedisClient('redis-subscriber');

		const pending = new Set(channels);
		this._subscriber.on('subscribe', (channel, count) => {
			this.logger.log("[redis-subscriber] Subscribed to '%s', %d total subscriptions", channel, count);
			if (!pending.delete(channel) || pending.size > 0)
				return; // A resubscription after a reconnect, or still waiting for others.
			this.emit('ready');
			callback(null);
		}).on('unsubscribe', (channel, count) => {
			this.logger.log("[redis-subscriber] Unsubscribed from '%s', %d total subscriptions", channel, count);
		}).on('message', (channel, raw) => {
			this._onRedisMessage(channel, raw);
		});

		// The client queues this until connected, and resubscribes on reconnect.
		// Note: redis@0.8 only expands an array argument when a callback is given;
		// without it, the channels would be joined into a single 'a,b' channel.
		this._subscriber.subscribe(channels, noop);

		return this;
	}

	// Unsubscribe and close every connection, letting in-flight pushes finish.
	// `callback(err)` is called once everything is closed.
	stop(callback) {
		callback = once(callback || noop);

		const closing = Object.keys(this._transports).map((platform) => this._transports[platform].close());
		this._transports = {};

		if (this.running) {
			this.running = false;
			const subscriber = this._subscriber;
			const client = this._client;
			this._subscriber = null;
			this._client = null;
			subscriber.unsubscribe();
			for (const redisClient of [ subscriber, client ]) {
				closing.push(new Promise((resolve, reject) =>
					redisClient.quit((err) => err ? reject(err) : resolve())));
			}
		}

		Promise.all(closing).then(() => callback(null), callback);
		return this;
	}

	// Send a notification right away, without going through Redis or locking.
	// `data` is a JSON string, a plain object, or an APNSMessage/FCMMessage.
	//
	// Returns a Promise of one result per recipient:
	//   { platform, recipient, ok: true, id }
	//   { platform, recipient, ok: false, error, status, unregistered, ... }
	// Delivery failures are results, not rejections; the Promise only rejects
	// if the message is invalid or the platform is not configured.
	// With a `callback(err, results)`, nothing is returned.
	send(platform, data, callback) {
		const promise = new Promise((resolve) => resolve(this._prepare(platform, data)))
			.then((message) => this._dispatch(message));
		if (typeof callback !== 'function')
			return promise;
		promise.then((results) => callback(null, results), callback);
		return undefined;
	}

	_prepare(platform, data) {
		platform = messages.normalizePlatform(platform);
		const isMessage = data instanceof messages.APNSMessage || data instanceof messages.FCMMessage;
		const message = isMessage ? data.validate() : messages.create(platform, data);
		if (message.platform !== platform)
			throw new Error('Cannot send a ' + message.platform + ' message via ' + platform);
		return message;
	}

	//
	// Redis
	//

	_createRedisClient(name) {
		const opts = this.options.redis;
		const client = redis.createClient(opts.port, opts.host, opts.options);
		if (opts.pass)
			client.auth(opts.pass);
		client.on('error', (err) => {
			this._error(name, err);
		}).on('connect', () => {
			this.logger.log('[%s] Connected', name);
		}).on('end', () => {
			this.logger.log('[%s] Connection closed', name);
		});
		return client;
	}

	_onRedisMessage(channel, raw) {
		const platform = this.options.redis.channels[channel];
		let message;

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
	}

	// Make sure only one instance sharing the same lock prefix sends a message.
	_lockAndDispatch(message) {
		const opts = this.options.redis;
		const worker = new RedisLockingWorker({
			client: this._client,
			lockKey: opts.lock.keyPrefix + message.identifier,
			statusLevel: RedisLockingWorker.StatusLevels.Verbose,
			lockTimeout: opts.lock.lockTimeout,
			maxAttempts: opts.lock.maxAttempts
		});

		worker.on('acquired', (lastAttempt) => {
			this.logger.log('[redis-lock] Acquired lock %s', worker.lockKey);
			this._dispatch(message).catch((err) => {
				this._error(message.platform, err);
			}).then(() => {
				// Release only once delivery was attempted, so a standby instance
				// can take over if this one dies mid-way.
				worker.done(opts.failoverEnabled ? lastAttempt : true);
			});
		}).on('locked', () => {
			this.logger.log('[redis-lock] Someone else acquired the lock %s', worker.lockKey);
		}).on('max-attempts', () => {
			this.logger.warn('[redis-lock] Giving up on lock %s after %d attempts', worker.lockKey, opts.lock.maxAttempts);
		}).on('status', (status) => {
			this.logger.log('[redis-lock] %s: %s', worker.lockKey, status);
		}).on('error', (err) => {
			this._error('redis-lock', err);
		});

		worker.acquire();
	}

	//
	// Delivery
	//

	async _dispatch(message) {
		const transport = this._transport(message.platform);
		this.logger.log("[%s] Sending notification '%s' to %d device(s)",
			message.platform, message.identifier, message.recipients().length);

		const results = await transport.send(message);

		for (const result of results) {
			if (result.ok) {
				this.logger.log("[%s] Transmitted to device '%s'", result.platform, result.recipient);
				this.emit('transmitted', result);
			} else {
				this.logger.error("[%s] Transmission error (%s) for device '%s'", result.platform, result.error, result.recipient);
				this.emit('transmissionError', result);
				if (result.unregistered)
					this.emit('unregistered', result);
			}
		}
		this.emit('sent', message, results);
		return results;
	}

	_transport(platform) {
		if (!this.options[platform])
			throw new Error(platform + ' is not configured');
		if (!this._transports[platform]) {
			const Transport = TRANSPORTS[platform];
			this._transports[platform] = new Transport(this.options[platform], {
				logger: this.logger,
				onError: (err) => this._error(err.source || platform, err)
			});
		}
		return this._transports[platform];
	}

	//
	// Helpers
	//

	_error(source, err) {
		if (!(err instanceof Error))
			err = new Error(String(err));
		err.source = source;
		this.logger.error('[%s] %s', source, err.message);
		this.emit('error', err);
	}
}

function once(fn) {
	let called = false;
	return function () {
		if (called)
			return;
		called = true;
		fn.apply(this, arguments);
	};
}

module.exports = Pusher;
