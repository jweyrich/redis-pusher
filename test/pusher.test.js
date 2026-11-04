'use strict';
//
// Pusher behaviour that does not need a Redis server.
//

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const RedisPusher = require('..');
const { stubSenders } = require('./helpers');

const APNS = { certificate: Buffer.from('fake'), feedback: { enabled: false } };
const GCM = { options: { key: 'key' } };

function recorder(pusher, names) {
	const events = [];
	for (const name of names)
		pusher.on(name, (...args) => events.push([ name, ...args ]));
	return events;
}

describe('Pusher', () => {
	let sent;
	before(() => { sent = stubSenders(); });
	after(() => sent.restore());
	// Reset is repeated in each nested suite below because Node 18.16 doesn't
	// run a parent suite's beforeEach hooks for tests in nested suites.
	beforeEach(() => sent.reset());

	it('can be created with or without `new`', () => {
		assert.ok(new RedisPusher({}) instanceof RedisPusher.Pusher);
		assert.ok(RedisPusher({}) instanceof RedisPusher.Pusher);
		assert.ok(RedisPusher.createPusher({}) instanceof RedisPusher.Pusher);
	});

	it('does not connect anywhere until started', () => {
		const pusher = RedisPusher({ gcm: GCM, redis: { channels: [ 'a:android' ] } });
		assert.equal(pusher.running, false);
		assert.equal(pusher._client, null);
		assert.equal(pusher._subscriber, null);
	});

	describe('send()', () => {
		beforeEach(() => sent.reset());
		it('validates and dispatches a GCM message', () => {
			const pusher = RedisPusher({ gcm: GCM });
			const events = recorder(pusher, [ 'sent' ]);
			const message = pusher.send('gcm', { registrationId: 'r1', data: { a: 1 } });

			assert.equal(sent.gcm.length, 1);
			assert.strictEqual(sent.gcm[0].message, message);
			assert.deepEqual(message.registrationId, [ 'r1' ]);
			assert.deepEqual(events, [ [ 'sent', message ] ]);
		});

		it('validates and dispatches an APNS message from JSON', () => {
			const pusher = RedisPusher({ apns: APNS });
			pusher.send('apns', '{"token":["t1","t2"],"alert":"hi"}');
			assert.equal(sent.apns.length, 1);
			assert.deepEqual(sent.apns[0].message.token, [ 't1', 't2' ]);
		});

		it('accepts a message instance', () => {
			const pusher = RedisPusher({ gcm: GCM });
			const message = new RedisPusher.GCMMessage({ registrationId: 'r' });
			assert.strictEqual(pusher.send('gcm', message), message);
			assert.deepEqual(message.registrationId, [ 'r' ]);
		});

		it('reuses one sender per platform', () => {
			const pusher = RedisPusher({ gcm: GCM });
			pusher.send('gcm', { registrationId: 'a' });
			pusher.send('gcm', { registrationId: 'b' });
			assert.strictEqual(sent.gcm[0].sender, sent.gcm[1].sender);
		});

		it('throws for a platform that is not configured', () => {
			const pusher = RedisPusher({ gcm: GCM });
			assert.throws(() => pusher.send('apns', { token: 't' }), /apns is not configured/);
			assert.equal(sent.apns.length, 0);
		});

		it('throws for a message of the wrong platform', () => {
			const pusher = RedisPusher({ apns: APNS, gcm: GCM });
			const message = new RedisPusher.APNSMessage({ token: 't' });
			assert.throws(() => pusher.send('gcm', message), /Cannot send a apns message via gcm/);
		});

		it('throws on an invalid message and sends nothing', () => {
			const pusher = RedisPusher({ gcm: GCM });
			assert.throws(() => pusher.send('gcm', { data: {} }), /registrationId/);
			assert.throws(() => pusher.send('gcm', 'not json'), SyntaxError);
			assert.equal(sent.gcm.length, 0);
		});
	});

	describe('GCM events', () => {
		beforeEach(() => sent.reset());
		it('re-emits transmitted, transmissionError and registrationUpdated', () => {
			const pusher = RedisPusher({ gcm: GCM });
			const events = recorder(pusher, [ 'transmitted', 'transmissionError', 'registrationUpdated' ]);
			pusher.send('gcm', { registrationId: [ 'r1', 'r2' ] });
			const { sender } = sent.gcm[0];

			sender.emit('transmitted', { message_id: 'm1' }, 'r1');
			sender.emit('transmissionError', 'NotRegistered', 'r2');
			sender.emit('updated', { registration_id: 'r1-new' }, 'r1');

			assert.deepEqual(events, [
				[ 'transmitted', { platform: 'gcm', recipient: 'r1', result: { message_id: 'm1' } } ],
				[ 'transmissionError', { platform: 'gcm', recipient: 'r2', error: 'NotRegistered' } ],
				[ 'registrationUpdated', {
					platform: 'gcm', recipient: 'r1', newRecipient: 'r1-new', result: { registration_id: 'r1-new' }
				} ]
			]);
		});

		it('emits sender errors as `error` with a source', () => {
			const pusher = RedisPusher({ gcm: GCM });
			const events = recorder(pusher, [ 'error' ]);
			pusher.send('gcm', { registrationId: 'r' });
			sent.gcm[0].sender.emit('error', 401);

			assert.equal(events.length, 1);
			const err = events[0][1];
			assert.ok(err instanceof Error);
			assert.equal(err.source, 'gcm-sender');
			assert.equal(err.message, '401');
		});
	});

	describe('APNS events', () => {
		beforeEach(() => sent.reset());
		const device = { toString: () => 'abcdef' };

		it('re-emits transmitted and transmissionError with the token as a string', () => {
			const pusher = RedisPusher({ apns: APNS });
			const events = recorder(pusher, [ 'transmitted', 'transmissionError' ]);
			pusher.send('apns', { token: 'abcdef' });
			const { sender } = sent.apns[0];
			const notification = { alert: 'hi' };

			sender.emit('transmitted', notification, device);
			sender.emit('transmissionError', 8, notification, device);
			sender.emit('transmissionError', 513, notification, undefined);

			assert.deepEqual(events, [
				[ 'transmitted', { platform: 'apns', recipient: 'abcdef', notification } ],
				[ 'transmissionError', { platform: 'apns', recipient: 'abcdef', error: 8, notification } ],
				[ 'transmissionError', { platform: 'apns', recipient: undefined, error: 513, notification } ]
			]);
		});

		it('emits gateway and socket errors as `error`', () => {
			const pusher = RedisPusher({ apns: APNS });
			const events = recorder(pusher, [ 'error' ]);
			pusher.send('apns', { token: 't' });
			sent.apns[0].sender.emit('error', new Error('bad cert'));
			sent.apns[0].sender.emit('socketError', new Error('ECONNRESET'));

			assert.deepEqual(events.map(([ , err ]) => [ err.source, err.message ]), [
				[ 'apns-gateway', 'bad cert' ],
				[ 'apns-gateway', 'ECONNRESET' ]
			]);
		});
	});

	describe('logger', () => {
		beforeEach(() => sent.reset());
		it('is silent by default and uses the given logger otherwise', () => {
			const lines = [];
			const logger = { log: (...a) => lines.push(a), warn: (...a) => lines.push(a), error: (...a) => lines.push(a) };
			RedisPusher({ gcm: GCM }).send('gcm', { registrationId: 'r' });
			assert.equal(lines.length, 0);

			RedisPusher({ gcm: GCM, logger }).send('gcm', { registrationId: 'r' });
			assert.ok(lines.some(([ format ]) => format.includes('Sending notification')), JSON.stringify(lines));
		});
	});

	describe('start() / stop()', () => {
		beforeEach(() => sent.reset());
		it('fails to start without channels', (t, done) => {
			RedisPusher({ gcm: GCM }).start((err) => {
				assert.match(err.message, /No channels configured/);
				done();
			});
		});

		it('stop() on a pusher that was never started calls back without error', (t, done) => {
			RedisPusher({}).stop((err) => {
				assert.equal(err, null);
				done();
			});
		});
	});
});
