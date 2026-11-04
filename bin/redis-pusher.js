#!/usr/bin/env node
//
// Run redis-pusher as a standalone service.
//
//   $ redis-pusher path/to/config.js
//   $ NODE_ENV=production redis-pusher        # loads ./private/config.production.js
//
// The config file exports the same options object accepted by
// `new RedisPusher(options)`, plus an optional `catchExceptions` flag.
//
// Note: on failure we set `process.exitCode` and return instead of calling
// `process.exit()`, which can drop pending output when stdout/stderr is a pipe.
//

var path = require('path')
	, RedisPusher = require('..');

function main() {
	var file = process.argv[2] || process.env.REDIS_PUSHER_CONFIG;
	if (!file)
		file = path.join('private', 'config.' + (process.env.NODE_ENV || 'development'));

	var configPath = path.resolve(file);
	var config;
	try {
		configPath = require.resolve(configPath);
		config = require(configPath);
	} catch (err) {
		console.error('Unable to load config file %s: %s', configPath, err.message);
		process.exitCode = 1;
		return;
	}

	if (!config.logger)
		config.logger = console;

	console.log('Using config ' + configPath);

	var pusher;
	try {
		pusher = RedisPusher.createPusher(config);
	} catch (err) {
		console.error('Invalid configuration: ' + err.message);
		process.exitCode = 1;
		return;
	}

	// Errors are already printed by the logger; keep running so the Redis client
	// can reconnect.
	pusher.on('error', function () {});

	pusher.on('feedback', function (devices) {
		devices.forEach(function (device) {
			// This is where you would mark the device as bad in your database.
			console.log("[apns-feedback] Should remove device: '%s'", device.token);
		});
	});

	if (config.catchExceptions) {
		process.on('uncaughtException', function (err) {
			console.error('Caught exception: ' + (err && err.stack || err));
		});
	}

	function shutdown() {
		console.log('Shutting down...');
		pusher.stop(function () {
			process.exit(0);
		});
		// Don't hang forever if Redis is unreachable.
		setTimeout(function () { process.exit(0); }, 5000).unref();
	}

	process.on('SIGINT', shutdown);
	process.on('SIGTERM', shutdown);

	pusher.start(function (err) {
		if (err) {
			console.error(err.message);
			process.exitCode = 1;
			pusher.stop();
		}
	});
}

main();
