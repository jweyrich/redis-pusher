/*
	$ NODE_ENV=development node . 
	$ NODE_ENV=production node . 
*/

var config = require("./private/config"),
	apn = require('apn'),
	redis = require("redis"),
	util = require('util'),
	RedisLockingWorker = require("redis-locking-worker"),
	APNSMessage = require("./lib/message");

var environment = process.env.NODE_ENV || 'development';
console.log('Running in ' + environment);

config[environment].redis.channels.forEach(function (channel, index) {
	config[environment].redis.channels[index] = environment + ':' + channel;
});

//
// REDIS MAIN CLIENT
//
var redisClient = redis.createClient(config[environment].redis.port, config[environment].redis.host);
if (config[environment].redis.pass)
	redisClient.auth(config[environment].redis.pass);
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
var redisSubscriber = redis.createClient(config[environment].redis.port, config[environment].redis.host);
if (config[environment].redis.pass)
	redisSubscriber.auth(config[environment].redis.pass);
redisSubscriber.on('error', function (err) {
	console.error("[redis-subscriber] " + err);
}).on('connect', function () {
	console.log("[redis-subscriber] Connected");
	redisSubscriber.subscribe(config[environment].redis.channels, function () {});
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
	console.log("[redis-subscriber] Received message: \"%s\"", message);
	// Error handling elided for brevity
	var apnsMessage = new APNSMessage(message);

	processMessage(apnsMessage);
});

//
// APNS GATEWAY
//
var apnsGateway = new apn.Connection(config[environment].apns.gateway.options);
apnsGateway.on('error', function (err) {
	console.error("[apns-gateway] " + err);
}).on('socketError', function (err) {
	console.error("[apns-gateway] " + err);
}).on('timeout', function (err) {
	console.error("[apns-gateway] Timeout");
}).on('transmissionError', function (errCode, notification, recipient) {
	console.error("[apns-gateway] Transmission error (code %d) for recipient", errCode, recipient);
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
var apnsFeedback = new apn.Feedback(config[environment].apns.feedback.options);
apnsFeedback.on('error', function (err) {
	console.error("[apns-feedback] " + err);
}).on('feedback', function (devices) {
	devices.forEach(function (item) {
		// Do something with item.device and item.time;
		console.log("[apns-feedback] Should remove device: %s", item.device);
	});
});

function processMessage(message) {
	var worker = new RedisLockingWorker({
		'client': redisClient,
		'lockKey' : config[environment].redis.lock.keyPrefix + message.identifier,
		'statusLevel' : RedisLockingWorker.StatusLevels.Verbose,
		'lockTimeout' : config[environment].redis.lock.lockTimeout,
		'maxAttempts' : config[environment].redis.lock.maxAttempts
	});
	worker.on("acquired", function (lastAttempt) {
		console.log("[redis-client] Acquired lock %s", worker.lockKey);
		dispatchMessage(message);
		if (config[environment].redis.failoverEnabled)
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

function dispatchMessage(message) {
	// Does some work to process the message and generate an APNS notification object
	var notification = buildApnsNotification(message);

	if (notification) {
		console.log("[apns-gateway] Sending notification %d to device %s",
			message.identifier, message.device_token);

		// The APNS connection is defined/initialized elsewhere
		apnsGateway.pushNotification(notification, message.device_token);
	}
}

function buildApnsNotification(message) {
	var note = new apn.Notification();
	// Expires in `message.expires` seconds from now.
	note.expiry = Math.floor(Date.now() / 1000) + message.expires;
	note.badge = message.badge;
	note.sound = message.sound;
	note.alert = message.alert;
	note.payload = message.payload;
	return note;
}

if (config[environment].catchExceptions) {
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
