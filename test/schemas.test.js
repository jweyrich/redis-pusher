'use strict';
//
// The JSON schemas in ../schemas are the published contract for publishers.
// These tests make sure the schemas and createMessage() agree on every case.
//

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const Ajv2020 = require('ajv/dist/2020');
const RedisPusher = require('..');

// strictRequired would flag the valid 'token or registrationId' anyOf in the FCM schema.
const ajv = new Ajv2020({ allErrors: true, strict: true, strictTypes: false, strictRequired: false });
const validators = {
	apns: ajv.compile(RedisPusher.schemas.apns),
	fcm: ajv.compile(RedisPusher.schemas.fcm)
};

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';

const cases = {
	apns: {
		valid: [
			{ token: TOKEN },
			{ token: [ TOKEN, 'ABCDEF' ] },
			{ identifier: 'id', token: TOKEN, alert: 'Hello' },
			{ identifier: 7, token: TOKEN, alert: { title: 'T', body: 'B' }, badge: 0, sound: 'default' },
			{ token: TOKEN, sound: { critical: 1, name: 'alarm.caf', volume: 1 } },
			{ token: TOKEN, category: 'c', threadId: 't', contentAvailable: true, mutableContent: false },
			{ token: TOKEN, payload: { custom: [ 1, 2 ] }, aps: { 'interruption-level': 'passive' } },
			{ token: TOKEN, expiry: 0 },
			{ token: TOKEN, expiry: 3600, priority: 5, pushType: 'background', topic: 'com.x', collapseId: 'c' },
			{ token: TOKEN, retryLimit: 3 } // Deprecated, ignored.
		],
		invalid: [
			{},
			{ token: '' },
			{ token: [] },
			{ token: 'not-hex' },
			{ token: '../../x' },
			{ token: [ TOKEN, 1 ] },
			{ token: TOKEN, identifier: {} },
			{ token: TOKEN, alert: 5 },
			{ token: TOKEN, badge: -1 },
			{ token: TOKEN, badge: 1.5 },
			{ token: TOKEN, badge: '1' },
			{ token: TOKEN, sound: true },
			{ token: TOKEN, category: 1 },
			{ token: TOKEN, threadId: [] },
			{ token: TOKEN, contentAvailable: 1 },
			{ token: TOKEN, mutableContent: 'yes' },
			{ token: TOKEN, payload: [] },
			{ token: TOKEN, aps: 'x' },
			{ token: TOKEN, expiry: -1 },
			{ token: TOKEN, expiry: '60' },
			{ token: TOKEN, expiry: 1.5 },
			{ token: TOKEN, priority: 7 },
			{ token: TOKEN, pushType: 1 },
			{ token: TOKEN, topic: {} },
			{ token: TOKEN, collapseId: 5 }
		]
	},
	fcm: {
		valid: [
			{ token: 't' },
			{ token: [ 't1', 't2' ] },
			{ registrationId: 'r' },
			{ registrationId: [ 'r1' ], delayWhileIdle: true }, // Legacy GCM fields.
			{ identifier: 'id', token: 't', notification: { title: 'T', body: 'B', image: 'https://x/y.png' } },
			{ token: 't', notification: {} },
			{ token: 't', data: { s: 'x', n: 1, o: { a: 1 } } },
			{ token: 't', collapseKey: 'k', timeToLive: 0, priority: 'high' },
			{ token: 't', timeToLive: 2419200, priority: 'normal' },
			{ token: 't', android: { ttl: '5s' }, apns: { headers: {} }, webpush: {}, fcmOptions: { analytics_label: 'l' } }
		],
		invalid: [
			{},
			{ data: { a: 'b' } },
			{ token: '' },
			{ token: ' ' },
			{ token: [] },
			{ token: [ 't', null ] },
			{ token: 't', identifier: [] },
			{ token: 't', notification: 'x' },
			{ token: 't', notification: { title: 1 } },
			{ token: 't', notification: { color: '#fff' } },
			{ token: 't', data: 'x' },
			{ token: 't', collapseKey: 1 },
			{ token: 't', timeToLive: -1 },
			{ token: 't', timeToLive: 2419201 },
			{ token: 't', timeToLive: '60' },
			{ token: 't', priority: 'urgent' },
			{ token: 't', android: [] },
			{ token: 't', apns: 'x' },
			{ token: 't', webpush: 1 },
			{ token: 't', fcmOptions: true }
		]
	}
};

for (const platform of Object.keys(cases)) {
	describe(platform + ' message schema', () => {
		const validate = validators[platform];

		it('accepts every message createMessage() accepts', () => {
			for (const message of cases[platform].valid) {
				assert.doesNotThrow(() => RedisPusher.createMessage(platform, message), JSON.stringify(message));
				assert.ok(validate(message), JSON.stringify(message) + ': ' + ajv.errorsText(validate.errors));
			}
		});

		it('rejects every message createMessage() rejects', () => {
			for (const message of cases[platform].invalid) {
				assert.throws(() => RedisPusher.createMessage(platform, message), TypeError, JSON.stringify(message));
				assert.ok(!validate(message), JSON.stringify(message) + ' should be invalid');
			}
		});

		it('has examples that are valid', () => {
			const { examples } = RedisPusher.schemas[platform];
			assert.ok(examples.length > 0);
			for (const message of examples) {
				assert.ok(validate(message), JSON.stringify(message) + ': ' + ajv.errorsText(validate.errors));
				assert.doesNotThrow(() => RedisPusher.createMessage(platform, message));
			}
		});

		it('describes every field the message class reads', () => {
			const { properties } = RedisPusher.schemas[platform];
			for (const field of Object.keys(properties))
				assert.ok(properties[field].description, field + ' has no description');
		});

		it('rejects unknown fields, which createMessage() ignores', () => {
			const message = Object.assign({}, cases[platform].valid[0], { tokens: [ 'typo' ] });
			assert.ok(!validate(message));
			assert.match(ajv.errorsText(validate.errors), /must NOT have additional properties/);
			assert.doesNotThrow(() => RedisPusher.createMessage(platform, message));
		});
	});
}
