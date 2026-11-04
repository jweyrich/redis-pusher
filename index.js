'use strict';

const Pusher = require('./lib/pusher');
const messages = require('./lib/messages');
const options = require('./lib/options');

// Callable with or without `new`.
function RedisPusher(opts) {
	return new Pusher(opts);
}

RedisPusher.Pusher = Pusher;
RedisPusher.createPusher = RedisPusher;
RedisPusher.APNSMessage = messages.APNSMessage;
RedisPusher.FCMMessage = messages.FCMMessage;
RedisPusher.GCMMessage = messages.FCMMessage; // Deprecated alias.
RedisPusher.createMessage = messages.create;
RedisPusher.defaults = options.DEFAULTS;
// JSON schemas for the messages, for publishers to validate against.
RedisPusher.schemas = {
	apns: require('./schemas/apns-message.schema.json'),
	fcm: require('./schemas/fcm-message.schema.json')
};

module.exports = RedisPusher;
