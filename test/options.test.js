'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');

const APNS = { certificate: 'cert.p12' };
const GCM = { options: { key: 'key' } };

describe('options', () => {
	it('applies defaults for anything not given', () => {
		const { options } = RedisPusher({ gcm: GCM, redis: { lock: { maxAttempts: 9 } } });
		assert.equal(options.redis.host, '127.0.0.1');
		assert.equal(options.redis.port, 6379);
		assert.equal(options.redis.lock.maxAttempts, 9);
		assert.equal(options.redis.lock.keyPrefix, 'push_lock_');
		assert.equal(options.redis.lock.lockTimeout, 5000);
		assert.equal(options.gcm.options.retries, 3);
	});

	it('does not share or mutate the defaults between instances', () => {
		const a = RedisPusher({ gcm: GCM });
		a.options.redis.lock.keyPrefix = 'changed';
		const b = RedisPusher({ gcm: GCM });
		assert.equal(b.options.redis.lock.keyPrefix, 'push_lock_');
		assert.equal(RedisPusher.defaults.redis.lock.keyPrefix, 'push_lock_');
		assert.deepEqual(RedisPusher.defaults.redis.channels, []);
	});

	it('does not mutate the user options object', () => {
		const userOptions = { gcm: GCM, redis: { channels: [ 'a:android' ] } };
		RedisPusher(userOptions);
		assert.deepEqual(userOptions.redis.channels, [ 'a:android' ]);
	});

	it('keeps class instances such as the logger as-is', () => {
		const { options } = RedisPusher({ logger: console });
		assert.strictEqual(options.logger, console);
	});

	it('keeps a Buffer certificate as-is', () => {
		const certificate = Buffer.from('pfx');
		const { options } = RedisPusher({ apns: { certificate } });
		assert.strictEqual(options.apns.certificate, certificate);
	});

	describe('platforms', () => {
		it('disables APNS without a certificate and GCM without a key', () => {
			const { options } = RedisPusher({});
			assert.equal(options.apns, false);
			assert.equal(options.gcm, false);
		});

		it('honours `false` to disable a platform', () => {
			const { options } = RedisPusher({ apns: false, gcm: GCM });
			assert.equal(options.apns, false);
			assert.ok(options.gcm);
		});

		it('merges APNS gateway/feedback settings over the defaults', () => {
			const { options } = RedisPusher({ apns: { certificate: 'c', gateway: { address: 'sandbox' } } });
			assert.equal(options.apns.gateway.address, 'sandbox');
			assert.equal(options.apns.gateway.connectionTimeout, 240000);
			assert.equal(options.apns.feedback.interval, 300);
		});
	});

	describe('redis.channels', () => {
		it('accepts an object mapping channels to platforms', () => {
			const channels = { one: 'apns', two: 'gcm' };
			const { options } = RedisPusher({ apns: APNS, gcm: GCM, redis: { channels } });
			assert.deepEqual(options.redis.channels, channels);
		});

		it('guesses the platform from channel names in an array', () => {
			const { options } = RedisPusher({
				apns: APNS, gcm: GCM,
				redis: { channels: [ 'x:apns', 'x:IOS', 'x:iphone', 'x:ipad', 'x:gcm', 'x:Android' ] }
			});
			assert.deepEqual(options.redis.channels, {
				'x:apns': 'apns', 'x:IOS': 'apns', 'x:iphone': 'apns', 'x:ipad': 'apns',
				'x:gcm': 'gcm', 'x:Android': 'gcm'
			});
		});

		it('accepts a single channel name', () => {
			const { options } = RedisPusher({ gcm: GCM, redis: { channels: 'x:android' } });
			assert.deepEqual(options.redis.channels, { 'x:android': 'gcm' });
		});

		it('throws when the platform cannot be guessed', () => {
			assert.throws(() => RedisPusher({ gcm: GCM, redis: { channels: [ 'notifications' ] } }),
				/Cannot tell which platform channel 'notifications' is for/);
		});

		it('throws on an unknown platform', () => {
			assert.throws(() => RedisPusher({ redis: { channels: { a: 'mpns' } } }), /unknown platform 'mpns'/);
		});

		it('throws when a channel targets a platform that is not configured', () => {
			assert.throws(() => RedisPusher({ gcm: GCM, redis: { channels: { a: 'apns' } } }),
				/apns is not configured \(apns.certificate is missing\)/);
			assert.throws(() => RedisPusher({ apns: APNS, redis: { channels: [ 'a:android' ] } }),
				/gcm is not configured \(gcm.options.key is missing\)/);
		});

		it('throws on an invalid type', () => {
			assert.throws(() => RedisPusher({ redis: { channels: 42 } }), TypeError);
		});
	});
});
