/*
	$ NODE_ENV=development node .
	$ NODE_ENV=production node .
*/

var _ = require('lodash')
	, notify = require('push-notify')
	, apn = require('apn')
	, redis = require("redis")
	, util = require('util')
	, RedisLockingWorker = require("redis-locking-worker")
	, messages = require("./lib/messages")
	, config = require("./config");

//
// REDIS MAIN CLIENT
//
var redisClient = redis.createClient(config.redis.port, config.redis.host);
if (config.redis.pass)
	redisClient.auth(config.redis.pass);
redisClient.on('error', function (err) {
	console.error("[redis-client] " + err);
}).on('connect', function () {
	console.log("[redis-client] Connected");
}).on('close', function (why) {
	console.log("[redis-client] " + why);
});

//
// REDIS SUBSCRIPTION CLIENT
//
var redisSubscriber = redis.createClient(config.redis.port, config.redis.host);
if (config.redis.pass)
	redisSubscriber.auth(config.redis.pass);
redisSubscriber.on('error', function (err) {
	console.error("[redis-subscriber] " + err);
}).on('connect', function () {
	console.log("[redis-subscriber] Connected");
	redisSubscriber.subscribe(config.redis.channels, function () {});
}).on('close', function (why) {
	console.log("[redis-subscriber] " + why);
}).on('subscribe', function (channel, count) {
	console.log("[redis-subscriber] Subscribed to %s, %d total subscriptions", channel, count);
}).on('unsubscribe', function (channel, count) {
    console.log("[redis-subscriber] Unsubscribed from %s, %d total subscriptions", channel, count);
    if (count === 0) {
        redisSubscriber.end();
    }
}).on('message', function (channel, message) {
	console.log("[redis-subscriber] Received message: '%s'", message);
	// Error handling elided for brevity
	var msg = buildMessageBasedOnChannel(channel, message);
	if (msg) {
		var compiled = msg.compile();
		if (compiled)
			processMessage(msg);
		else
			console.warn('Invalid message?');
	}
});

function buildMessageBasedOnChannel (channel, message) {
	var chan = channel.toLowerCase();
	if (chan.indexOf('gcm') != -1 || chan.indexOf('android') != -1)
		return new messages.GCMMessage(message);
	if (chan.indexOf('apns') != -1 || chan.indexOf('ios') != -1  || chan.indexOf('iphone') != -1 )
		return new messages.APNSMessage(message);
	return undefined;
}

//
// APNS GATEWAY
//
var apnsGateway = new notify.apn.Sender(config.apns.gateway.options);
apnsGateway.on('error', function (err) {
	console.error("[apns-gateway] " + err);
}).on('socketError', function (err) {
	console.error("[apns-gateway] " + err);
}).on('timeout', function (err) {
	console.error("[apns-gateway] Timeout");
}).on('transmissionError', function (errCode, notification, device) {
	console.error("[apns-gateway] Transmission error (code %d) for recipient (%s)", errCode, device);
}).on('connected', function (count) {
	console.log("[apns-gateway] Connected, %d total sockets", count);
}).on('disconnected', function (count) {
	console.log("[apns-gateway] Disconnected, %d total sockets", count);
}).on('transmitted', function (notification, recipient) {
	console.log("[apns-gateway] Transmitted %s to device %s", notification, recipient);
});

//
// APNS FEEDBACK
//
var apnsFeedback = new apn.Feedback(config.apns.feedback.options);
apnsFeedback.on('error', function (err) {
	// Emitted when an error occurs initialising the module. Usually caused by failing to load the certificates.
	// This is most likely an unrecoverable error.
	console.error("[apns-feedback] " + err);
}).on('feedbackError', function (err) {
	// Emitted when an error occurs receiving or processing the feedback and in the case of a socket error occurring.
	// These errors are usually informational and node-apn will automatically recover.
	console.error("[apns-feedback] " + err);
}).on('feedback', function (feedbackData) {
	feedbackData.forEach(function (item) {
		var time = item[i].time;
		var device = item[i].device;

		// Do something with item.device and item.time;
		console.log("[apns-feedback] Should remove device: %s", device);
	});
});

//
// GCM SENDER
//
var gcmSender = new notify.gcm.Sender(config.gcm.options);
gcmSender.on('error', function (err) {
	console.error("[gcm-sender] " + err);
}).on('transmissionError', function (err, registrationId) {
	console.error("[gcm-sender] Transmission error (code %d) for recipient (%s)", err, registrationId);
}).on('updated', function (result, registrationId) {
	console.log("[gcm-sender] Registration ID needs to be updated (%s) ", registrationId);
}).on('transmitted', function (result, registrationId) {
	console.log("[gcm-sender] Transmitted %s to device %s", result, registrationId);
});

function processMessage(message) {
	var worker = new RedisLockingWorker({
		'client': redisClient,
		'lockKey' : config.redis.lock.keyPrefix + message.identifier,
		'statusLevel' : RedisLockingWorker.StatusLevels.Verbose,
		'lockTimeout' : config.redis.lock.lockTimeout,
		'maxAttempts' : config.redis.lock.maxAttempts
	});
	worker.on("acquired", function (lastAttempt) {
		console.log("[redis-client] Acquired lock %s", worker.lockKey);
		message.dispatch();
		if (config.redis.failoverEnabled)
			worker.done(lastAttempt);
		else {
			console.log("[redis-client] Work complete. Deleting lock %s", worker.lockKey);
			worker.done(true);
		}
		worker = undefined;
	});
	worker.on("locked", function () {
		console.log("[redis-client] Someone else acquired the lock %s", worker.lockKey);
	});
	worker.on("error", function (error) {
		console.error("[redis-client] Error from lock %s: %j", worker.lockKey, error);
	});
	worker.on("status", function (message) {
		console.log("[redis-client] Status message from lock %s: %s", worker.lockKey, message);
	});
	worker.acquire();
}

messages.APNSMessage.prototype.dispatch = function () {
	console.log("[apns-gateway] Sending notification '%s' to device(s) [ %s ]",
		this.identifier, this.token.join(", "));

	// The APNS connection is defined/initialized elsewhere
	apnsGateway.send(this);
};

messages.GCMMessage.prototype.dispatch = function () {
	console.log("[gcm-sender] Sending notification '%s' to device(s) [ %s ]",
		this.identifier, this.registrationId.join(", "));

	// The APNS connection is defined/initialized elsewhere
	gcmSender.send(this);
};

if (config.catchExceptions) {
	process.on('uncaughtException', function (err) {
		console.error('Caught exception: ' + err);
	});
}

process.on('exit', function () {
	console.log('Dumping redis dataset to disk...');
	if (redisClient.connected) {
		redisClient.save();
	}
	console.log('Exiting.');
});
