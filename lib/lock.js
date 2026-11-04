'use strict';
//
// A Redis lock that makes sure only one of several instances sharing the same
// key prefix delivers each message, with optional failover to a standby
// instance if the one delivering it dies.
//
// Lock key values:
//   '<attempt>:<owner>'  An instance is delivering (attempt 1, 2, ...). The
//                        holder keeps renewing the key's TTL (lockTimeout)
//                        while it works, so the key only expires if it dies.
//   'DONE'               Delivered. Kept for a while (failover mode only) so
//                        standby instances know not to take over.
//
// Without failover, instances that lose the race skip the message, and the
// key is deleted once delivery has been attempted.
//
// With failover, losers become standbys: every `lockTimeout` they check the
// key. 'DONE' means they're finished. An expired key means the holder died,
// so they take over with the next attempt number, up to `maxAttempts`.
//

const crypto = require('crypto');

// Renew the TTL, only if we still hold the lock.
const EXTEND = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
	return redis.call('PEXPIRE', KEYS[1], ARGV[2])
end
return 0`;

// Mark as done (or delete when ARGV[2] is '0'), only if we still hold the lock.
const RELEASE = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
	return 0
end
if ARGV[2] == '0' then
	redis.call('DEL', KEYS[1])
else
	redis.call('SET', KEYS[1], 'DONE', 'PX', ARGV[2])
end
return 1`;

const DONE = 'DONE';

class Locker {
	constructor(client, { keyPrefix, lockTimeout, maxAttempts, failover }, { logger, onError } = {}) {
		this.client = client;
		this.keyPrefix = keyPrefix;
		this.lockTimeout = lockTimeout;
		this.maxAttempts = maxAttempts;
		this.failover = failover;
		this.logger = logger;
		this.onError = onError || (() => {});
		this.owner = crypto.randomUUID();
		this.cancelled = false;
		this.waits = new Set();
	}

	// Run `work(attempt)` for `id` unless another instance is (or was) doing it.
	// Resolves once this instance is finished with `id`: it did the work,
	// skipped it, or gave up. Never rejects: Redis errors go to `onError`.
	async run(id, work) {
		const key = this.keyPrefix + id;
		try {
			await this._run(key, work);
		} catch (err) {
			if (!this.cancelled)
				this.onError(err);
		}
	}

	// Stop waiting as a standby (used when shutting down).
	cancel() {
		this.cancelled = true;
		for (const wait of this.waits)
			wait();
		this.waits.clear();
	}

	async _run(key, work) {
		let lastAttempt = 0;

		for (;;) {
			if (this.cancelled)
				return;

			const attempt = lastAttempt + 1;
			if (attempt > this.maxAttempts) {
				this.logger.warn('[redis-lock] Giving up on %s after %d attempts', key, this.maxAttempts);
				return;
			}

			const token = attempt + ':' + this.owner;
			const acquired = await this.client.set(key, token, {
				condition: 'NX',
				expiration: { type: 'PX', value: this.lockTimeout }
			});
			if (acquired) {
				this.logger.log('[redis-lock] Acquired lock %s (attempt %d)', key, attempt);
				return this._hold(key, token, attempt, work);
			}

			if (!this.failover) {
				this.logger.log('[redis-lock] Someone else acquired the lock %s', key);
				return;
			}

			// Standby: wait for the holder to finish, or to disappear.
			let value = await this.client.get(key);
			while (value !== null) {
				if (value === DONE) {
					this.logger.log('[redis-lock] %s was completed by another instance', key);
					return;
				}
				lastAttempt = Math.max(lastAttempt, parseInt(value, 10) || 0);
				this.logger.log('[redis-lock] %s is held by another instance (attempt %d), waiting', key, lastAttempt);
				await this._sleep(this.lockTimeout);
				if (this.cancelled)
					return;
				value = await this.client.get(key);
			}
			// The key expired: its holder is gone. Try to take over.
		}
	}

	async _hold(key, token, attempt, work) {
		const interval = Math.max(Math.floor(this.lockTimeout / 3), 10);
		const heartbeat = setInterval(() => {
			this.client.eval(EXTEND, { keys: [ key ], arguments: [ token, String(this.lockTimeout) ] }).then((extended) => {
				if (!extended)
					this.logger.warn('[redis-lock] Lost lock %s while delivering', key);
			}, (err) => this.onError(err));
		}, interval);

		try {
			await work(attempt);
		} finally {
			clearInterval(heartbeat);
		}

		// With failover, leave a 'DONE' marker long enough for every standby to see it.
		const doneTTL = this.failover ? this.lockTimeout * (this.maxAttempts + 1) : 0;
		await this.client.eval(RELEASE, { keys: [ key ], arguments: [ token, String(doneTTL) ] });
	}

	_sleep(ms) {
		return new Promise((resolve) => {
			const done = () => {
				clearTimeout(timer);
				this.waits.delete(done);
				resolve();
			};
			const timer = setTimeout(done, ms);
			this.waits.add(done);
		});
	}
}

module.exports = Locker;
