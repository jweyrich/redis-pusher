'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { APNSMessage, GCMMessage, createMessage } = require('..');

describe('APNSMessage', () => {
	it('parses a JSON string and normalizes `token` to an array', () => {
		const message = createMessage('apns', '{"identifier":"a","token":"t1","alert":"hi"}');
		assert.ok(message instanceof APNSMessage);
		assert.equal(message.platform, 'apns');
		assert.equal(message.identifier, 'a');
		assert.deepEqual(message.token, [ 't1' ]);
		assert.equal(message.alert, 'hi');
	});

	it('accepts a plain object and a Buffer', () => {
		assert.deepEqual(createMessage('apns', { token: [ 'a', 'b' ] }).token, [ 'a', 'b' ]);
		assert.deepEqual(createMessage('apns', Buffer.from('{"token":"x"}')).token, [ 'x' ]);
	});

	it('keeps falsy values such as `badge: 0`', () => {
		assert.strictEqual(createMessage('apns', { token: 't', badge: 0 }).badge, 0);
	});

	it('only sets the fields that were provided', () => {
		const message = createMessage('apns', { token: 't' });
		assert.deepEqual(Object.keys(message).sort(), [ 'payload', 'token' ]);
		assert.deepEqual(message.payload, {});
	});

	it('does not expose `platform` as an own enumerable field', () => {
		const message = createMessage('apns', { token: 't' });
		assert.ok(!Object.keys(message).includes('platform'));
	});

	it('converts `expiry` from seconds-from-now to a timestamp', () => {
		const now = Math.floor(Date.now() / 1000);
		const { expiry } = createMessage('apns', { token: 't', expiry: 60 });
		assert.ok(expiry >= now + 60 && expiry <= now + 61, 'expiry=' + expiry);
	});

	it('throws SyntaxError on invalid JSON', () => {
		assert.throws(() => createMessage('apns', '{oops'), SyntaxError);
	});

	it('throws TypeError on non-object input', () => {
		for (const data of [ 42, null, undefined, [ 'a' ], true ])
			assert.throws(() => new APNSMessage(data), TypeError, String(data));
	});

	it('rejects missing or invalid tokens', () => {
		for (const token of [ undefined, '', [], [ 'a', 1 ], [ 'a', '' ], 123, { a: 1 } ])
			assert.throws(() => createMessage('apns', { token }), /`token` must be/, JSON.stringify(token));
	});

	it('rejects an identifier that is not a string or number', () => {
		assert.throws(() => createMessage('apns', { token: 't', identifier: {} }), /`identifier`/);
		assert.doesNotThrow(() => createMessage('apns', { token: 't', identifier: 7 }));
	});
});

describe('GCMMessage', () => {
	it('parses and normalizes `registrationId` to an array', () => {
		const message = createMessage('gcm', '{"identifier":"g","registrationId":"r1","data":{"k":"v"}}');
		assert.ok(message instanceof GCMMessage);
		assert.equal(message.platform, 'gcm');
		assert.deepEqual(message.registrationId, [ 'r1' ]);
		assert.deepEqual(message.data, { k: 'v' });
	});

	it('keeps `delayWhileIdle: false` and `timeToLive: 0`', () => {
		const message = createMessage('gcm', { registrationId: 'r', delayWhileIdle: false, timeToLive: 0 });
		assert.strictEqual(message.delayWhileIdle, false);
		assert.strictEqual(message.timeToLive, 0);
	});

	it('rejects missing or invalid registration IDs', () => {
		for (const registrationId of [ undefined, '', [], [ 'a', null ] ])
			assert.throws(() => createMessage('gcm', { registrationId }), /`registrationId` must be/);
	});
});

describe('createMessage', () => {
	it('throws on an unknown platform', () => {
		assert.throws(() => createMessage('mpns', { token: 't' }), /Unknown platform: mpns/);
	});
});
