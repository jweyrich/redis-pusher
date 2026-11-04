'use strict';

const EventEmitter = require('events');
const { createClient } = require('@redis/client');
const messages = require('./messages');
const normalizeOptions = require('./options');
const APNSTransport = require('./apns');
const FCMTransport = require('./fcm');
const Locker = require('./lock');

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
		this._locker = null;
		this._transports = {};
		this._inflight = new Set();

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
		const redisOptions = this.options.redis;
		const client = this._client = this._createRedisClient('redis-client');
		const subscriber = this._subscriber = this._createRedisClient('redis-subscriber', client);
		this._locker = new Locker(client, {
			keyPrefix: redisOptions.lock.keyPrefix,
			lockTimeout: redisOptions.lock.lockTimeout,
			maxAttempts: redisOptions.lock.maxAttempts,
			failover: redisOptions.failoverEnabled
		}, {
			logger: this.logger,
			onError: (err) => this._error('redis-lock', err)
		});

		// Both clients retry until Redis is reachable, emitting 'error' meanwhile.
		// After a reconnect, the subscriber resubscribes on its own.
		Promise.all([ client.connect(), subscriber.connect() ])
			.then(() => subscriber.subscribe(channels, (raw, channel) => this._onRedisMessage(channel, raw)))
			.then(() => {
				if (this._subscriber !== subscriber)
					return callback(new Error('Pusher was stopped before it was ready'));
				this.logger.log('[redis-subscriber] Subscribed to %s', channels.map((c) => "'" + c + "'").join(', '));
				this.emit('ready');
				callback(null);
			}, (err) => {
				callback(this._subscriber === subscriber ? err : new Error('Pusher was stopped before it was ready'));
			});

		return this;
	}

	// Unsubscribe, let in-flight pushes finish, then close every connection.
	// `callback(err)` is called once everything is closed.
	stop(callback) {
		callback = once(callback || noop);
		this._stop().then(() => callback(null), callback);
		return this;
	}

	async _stop() {
		const client = this._client;
		const subscriber = this._subscriber;
		this.running = false;
		this._client = null;
		this._subscriber = null;

		if (subscriber) {
			// Stop receiving messages and stop waiting as a standby.
			this._locker.cancel();
			if (subscriber.isReady)
				await subscriber.unsubscribe().catch(noop);
		}

		// Let deliveries in progress finish (and release their locks).
		await Promise.all(Array.from(this._inflight));

		const transports = this._transports;
		this._transports = {};
		await Promise.all(Object.keys(transports).map((platform) => transports[platform].close()));

		for (const redisClient of [ subscriber, client ]) {
			if (!redisClient)
				continue;
			if (redisClient.isReady)
				await redisClient.close();
			else
				redisClient.destroy(); // Still trying to connect.
		}
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

	_createRedisClient(name, original) {
		let client;
		if (original) {
			client = original.duplicate();
		} else {
			const opts = this.options.redis;
			const clientOptions = Object.assign({}, opts.options);
			if (opts.url)
				clientOptions.url = opts.url;
			else
				clientOptions.socket = Object.assign({ host: opts.host, port: opts.port }, clientOptions.socket);
			if (opts.username)
				clientOptions.username = opts.username;
			if (opts.password || opts.pass)
				clientOptions.password = opts.password || opts.pass;
			client = createClient(clientOptions);
		}
		client.on('error', (err) => {
			this._error(name, err);
		}).on('ready', () => {
			this.logger.log('[%s] Connected', name);
		}).on('reconnecting', () => {
			this.logger.log('[%s] Reconnecting', name);
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

		// Only one instance sharing the lock prefix delivers each message.
		const delivery = this._locker.run(String(message.identifier), () =>
			this._dispatch(message).catch((err) => this._error(message.platform, err)));
		this._inflight.add(delivery);
		delivery.then(() => this._inflight.delete(delivery));
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
