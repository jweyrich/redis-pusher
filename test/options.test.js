'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const RedisPusher = require('..');
const { generateCredentials } = require('./mocks');

const credentials = generateCredentials();
const { key, keyId, teamId, topic } = credentials.apns;
const APNS = { key, keyId, teamId, topic };
const FCM = { serviceAccount: credentials.fcm.serviceAccount };

describe('options', () => {
	let dir;
	before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-pusher-options-')); });
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	it('applies defaults for anything not given', () => {
		const { options } = RedisPusher({ fcm: FCM, redis: { lock: { maxAttempts: 9 } } });
		assert.equal(options.redis.host, '127.0.0.1');
		assert.equal(options.redis.port, 6379);
		assert.equal(options.redis.lock.maxAttempts, 9);
		assert.equal(options.redis.lock.keyPrefix, 'push_lock_');
		assert.equal(options.fcm.url, 'https://fcm.googleapis.com');
		assert.equal(options.fcm.retries, 3);
	});

	it('does not share or mutate the defaults between instances', () => {
		const a = RedisPusher({ fcm: FCM });
		a.options.redis.lock.keyPrefix = 'changed';
		const b = RedisPusher({ fcm: FCM });
		assert.equal(b.options.redis.lock.keyPrefix, 'push_lock_');
		assert.equal(RedisPusher.defaults.redis.lock.keyPrefix, 'push_lock_');
		assert.deepEqual(RedisPusher.defaults.redis.channels, []);
		assert.equal(RedisPusher.defaults.fcm.serviceAccount, undefined);
	});

	it('does not mutate the user options object', () => {
		const userOptions = { fcm: { serviceAccount: JSON.stringify(credentials.fcm.serviceAccount) }, redis: { channels: [ 'a:android' ] } };
		RedisPusher(userOptions);
		assert.deepEqual(userOptions.redis.channels, [ 'a:android' ]);
		assert.equal(typeof userOptions.fcm.serviceAccount, 'string');
	});

	it('keeps class instances such as the logger as-is', () => {
		const { options } = RedisPusher({ logger: console });
		assert.strictEqual(options.logger, console);
	});

	describe('apns', () => {
		it('is disabled without credentials, or with `false`', () => {
			assert.equal(RedisPusher({}).options.apns, false);
			assert.equal(RedisPusher({ apns: false }).options.apns, false);
		});

		it('accepts the .p8 key as PEM text, a Buffer or a file path', () => {
			const file = path.join(dir, 'AuthKey.p8');
			fs.writeFileSync(file, key);
			for (const value of [ key, Buffer.from(key), file])
				assert.equal(RedisPusher({ apns: Object.assign({}, APNS, { key: value }) }).options.apns.key, key);
		});

		it('requires keyId, teamId and topic with a .p8 key', () => {
			assert.throws(() => RedisPusher({ apns: { key, teamId, topic } }), /requires apns.keyId and apns.teamId/);
			assert.throws(() => RedisPusher({ apns: { key, keyId, topic } }), /requires apns.keyId and apns.teamId/);
			assert.throws(() => RedisPusher({ apns: { key, keyId, teamId } }), /apns.topic .* is required/);
		});

		it('reports unreadable or invalid credentials when created', () => {
			assert.throws(() => RedisPusher({ apns: Object.assign({}, APNS, { key: path.join(dir, 'missing.p8') }) }),
				/Unable to read apns.key from .*missing.p8/);
			assert.throws(() => RedisPusher({ apns: Object.assign({}, APNS, { key: '-----BEGIN PRIVATE KEY-----\nnope\n-----END PRIVATE KEY-----' }) }),
				/Invalid apns.key/);
			assert.throws(() => RedisPusher({ apns: { certificate: Buffer.from('not a p12') } }),
				/Invalid apns.certificate or apns.passphrase/);
			assert.throws(() => RedisPusher({ apns: { certificate: path.join(dir, 'missing.p12') } }),
				/Unable to read apns.certificate/);
		});

		it('targets production by default, or the sandbox', () => {
			assert.equal(RedisPusher({ apns: APNS }).options.apns.production, true);
			assert.equal(RedisPusher({ apns: Object.assign({ production: false }, APNS) }).options.apns.production, false);
		});

		it('maps a legacy sandbox `gateway.address` to production: false and drops legacy keys', () => {
			const { options } = RedisPusher({ apns: Object.assign({
				gateway: { address: 'gateway.sandbox.push.apple.com' },
				feedback: { address: 'feedback.sandbox.push.apple.com' }
			}, APNS) });
			assert.equal(options.apns.production, false);
			assert.ok(!('gateway' in options.apns) && !('feedback' in options.apns));
		});
	});

	describe('fcm', () => {
		it('is disabled without a service account, or with `false`', () => {
			assert.equal(RedisPusher({}).options.fcm, false);
			assert.equal(RedisPusher({ fcm: false }).options.fcm, false);
		});

		it('accepts the service account as an object, JSON text or a file path', () => {
			const file = path.join(dir, 'service-account.json');
			const json = JSON.stringify(credentials.fcm.serviceAccount);
			fs.writeFileSync(file, json);
			for (const value of [ credentials.fcm.serviceAccount, json, file ])
				assert.deepEqual(RedisPusher({ fcm: { serviceAccount: value } }).options.fcm.serviceAccount, credentials.fcm.serviceAccount);
		});

		it('validates the service account', () => {
			assert.throws(() => RedisPusher({ fcm: { serviceAccount: '{nope' } }), /not valid JSON/);
			assert.throws(() => RedisPusher({ fcm: { serviceAccount: { client_email: 'x' } } }), /must be a service account key/);
			const noProject = Object.assign({}, credentials.fcm.serviceAccount, { project_id: undefined });
			assert.throws(() => RedisPusher({ fcm: { serviceAccount: noProject } }), /fcm.projectId is required/);
			assert.doesNotThrow(() => RedisPusher({ fcm: { serviceAccount: noProject, projectId: 'p' } }));
			const badKey = Object.assign({}, credentials.fcm.serviceAccount, { private_key: 'nope' });
			assert.throws(() => RedisPusher({ fcm: { serviceAccount: badKey } }), /Invalid private_key/);
		});

		it('rejects legacy GCM settings with a migration hint', () => {
			assert.throws(() => RedisPusher({ gcm: { options: { key: 'AIza...' } } }), /GCM was shut down.*fcm\.serviceAccount/);
			assert.doesNotThrow(() => RedisPusher({ gcm: false }));
		});
	});

	describe('redis', () => {
		it('defaults to 127.0.0.1:6379 with no credentials', () => {
			const { redis } = RedisPusher({}).options;
			assert.deepEqual([ redis.url, redis.host, redis.port, redis.username, redis.password ],
				[ undefined, '127.0.0.1', 6379, undefined, undefined ]);
		});

		it('validates the lock settings', () => {
			assert.throws(() => RedisPusher({ redis: { lock: { lockTimeout: 0 } } }), /lockTimeout must be a positive number/);
			assert.throws(() => RedisPusher({ redis: { lock: { maxAttempts: 0 } } }), /maxAttempts must be an integer >= 1/);
			assert.throws(() => RedisPusher({ redis: { lock: { maxAttempts: 1.5 } } }), /maxAttempts/);
		});
	});

	describe('redis.channels', () => {
		it('accepts an object mapping channels to platforms, with `gcm` as an alias', () => {
			const { options } = RedisPusher({ apns: APNS, fcm: FCM, redis: { channels: { one: 'apns', two: 'fcm', three: 'gcm' } } });
			assert.deepEqual(options.redis.channels, { one: 'apns', two: 'fcm', three: 'fcm' });
		});

		it('guesses the platform from channel names in an array', () => {
			const { options } = RedisPusher({
				apns: APNS, fcm: FCM,
				redis: { channels: [ 'x:apns', 'x:IOS', 'x:iphone', 'x:ipad', 'x:fcm', 'x:gcm', 'x:Android' ] }
			});
			assert.deepEqual(options.redis.channels, {
				'x:apns': 'apns', 'x:IOS': 'apns', 'x:iphone': 'apns', 'x:ipad': 'apns',
				'x:fcm': 'fcm', 'x:gcm': 'fcm', 'x:Android': 'fcm'
			});
		});

		it('accepts a single channel name', () => {
			assert.deepEqual(RedisPusher({ fcm: FCM, redis: { channels: 'x:android' } }).options.redis.channels, { 'x:android': 'fcm' });
		});

		it('throws when the platform cannot be guessed or is unknown', () => {
			assert.throws(() => RedisPusher({ fcm: FCM, redis: { channels: [ 'notifications' ] } }),
				/Cannot tell which platform channel 'notifications' is for/);
			assert.throws(() => RedisPusher({ redis: { channels: { a: 'mpns' } } }), /unknown platform 'mpns'/);
			assert.throws(() => RedisPusher({ redis: { channels: 42 } }), TypeError);
		});

		it('throws when a channel targets a platform that is not configured', () => {
			assert.throws(() => RedisPusher({ fcm: FCM, redis: { channels: { a: 'apns' } } }), /apns is not configured/);
			assert.throws(() => RedisPusher({ apns: APNS, redis: { channels: [ 'a:android' ] } }), /fcm is not configured \(set fcm.serviceAccount\)/);
		});
	});
});
