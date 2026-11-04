# redis-pusher

A Node.js library (and CLI) that consumes messages published on Redis channels
and sends them as Push Notifications via APNS or GCM.

- **Events**: listens for messages published on the configured Redis channel(s).
- **Processing**: converts each message to the APNS or GCM format and dispatches it.
- **Feedback**: periodically polls the APNS Feedback service and tells you which
  devices have persistent delivery failures, so you can stop pushing to them.

## Install

	$ npm install redis-pusher

## Usage as a library

```js
var RedisPusher = require('redis-pusher');

var pusher = RedisPusher.createPusher({
	logger: console, // Optional. Silent by default.
	redis: {
		host: '127.0.0.1',
		port: 6379,
		channels: {
			'push:ios': 'apns',
			'push:android': 'gcm'
		}
	},
	apns: {
		certificate: '/path/to/apns_production.p12', // Path or Buffer.
		passphrase: 'secret'
	},
	gcm: {
		options: { key: 'YOUR_GCM_API_KEY' }
	}
});

pusher.on('error', function (err) {
	// Connection/protocol errors. `err.source` is one of 'redis-client',
	// 'redis-subscriber', 'redis-lock', 'apns-gateway', 'apns-feedback',
	// 'gcm-sender', 'apns' or 'gcm'.
	console.error(err.source, err);
});

pusher.on('feedback', function (devices) {
	// APNS says these devices are no longer reachable.
	devices.forEach(function (device) {
		db.markDeviceAsBad(device.token, device.time);
	});
});

pusher.on('registrationUpdated', function (info) {
	// GCM says this registration ID has a new canonical ID.
	db.replaceRegistrationId(info.recipient, info.newRecipient);
});

pusher.on('transmissionError', function (info) {
	// info: { platform, recipient, error, notification|result }
	if (info.platform === 'gcm' && info.error === 'NotRegistered')
		db.removeRegistrationId(info.recipient);
});

pusher.start(function (err) {
	if (err) throw err;
	console.log('Listening for push messages');
});

// Later:
pusher.stop(function () { console.log('Stopped'); });
```

Then publish messages from anywhere:

	redis> publish push:ios '{ "identifier": "msg-1", "token": "<device_token>", "alert": "Hello!" }'

### Sending without Redis

`send()` delivers a notification immediately. It doesn't need `start()`, a
Redis connection or a lock:

```js
var pusher = RedisPusher.createPusher({ gcm: { options: { key: 'KEY' } } });

pusher.send('gcm', { registrationId: [ 'id1', 'id2' ], data: { foo: 'bar' } });
```

`send()` throws if the message is invalid or the platform isn't configured.
Delivery results arrive through the `transmitted` / `transmissionError` events.

### API

#### `new RedisPusher(options)` / `RedisPusher.createPusher(options)`

Creates a pusher. It doesn't connect until you call `start()`. Throws if the
options are inconsistent (for example, a channel mapped to a platform that
isn't configured).

#### `pusher.start([callback])`

Connects to Redis, subscribes to `redis.channels`, and starts polling the APNS
Feedback service. Calls `callback(err)` once subscribed.

#### `pusher.stop([callback])`

Unsubscribes, closes the Redis and APNS connections, and stops the feedback
polling. Calls `callback(err)` once the Redis connections are closed.

#### `pusher.send(platform, message)`

Sends `message` (a JSON string, a plain object or an `APNSMessage`/`GCMMessage`)
via `platform` (`'apns'` or `'gcm'`). Returns the validated message.

#### Events

| Event                 | Arguments                 | When                                                       |
|-----------------------|---------------------------|------------------------------------------------------------|
| `ready`               | –                         | Subscribed to all configured channels.                     |
| `message`             | `(message, channel)`      | A valid message was received from Redis.                   |
| `invalid`             | `(error, channel, raw)`   | A message from Redis was rejected (bad JSON, missing fields). |
| `sent`                | `(message)`               | A message was handed to the APNS/GCM sender.               |
| `transmitted`         | `(info)`                  | Delivered to a device: `{ platform, recipient, notification\|result }`. |
| `transmissionError`   | `(info)`                  | Rejected for a device: `{ platform, recipient, error, notification\|result }`. |
| `registrationUpdated` | `(info)`                  | GCM canonical ID: `{ platform, recipient, newRecipient, result }`. |
| `feedback`            | `(devices)`               | APNS feedback: `[ { token, time } ]`, `time` is a `Date`.  |
| `error`               | `(error)`                 | Connection/protocol errors; see `error.source`.            |

As with any Node.js `EventEmitter`, an `error` event with no listener throws.
**Always listen for `error`.**

#### Other exports

- `RedisPusher.APNSMessage`, `RedisPusher.GCMMessage`: the message classes.
- `RedisPusher.createMessage(platform, data)`: builds and validates a message, or throws.
- `RedisPusher.defaults`: the default options (read-only).

### Options

Anything you don't set falls back to these defaults:

	logger                         -- Object with console-like log/warn/error. Default: silent.

	redis.host                     -- Default: '127.0.0.1'.
	redis.port                     -- Default: 6379.
	redis.pass                     -- Password, or '' if none. Default: ''.
	redis.options                  -- Passed to redis.createClient(). Default: {}.
	redis.channels                 -- Channels to subscribe to. Either an object mapping each channel to
	                                  its platform, e.g. { 'push:ios': 'apns', 'push:android': 'gcm' },
	                                  or an array of names, in which case the platform is guessed from
	                                  the name: 'apns', 'ios', 'iphone' or 'ipad' => apns;
	                                  'gcm' or 'android' => gcm.
	redis.failoverEnabled          -- See "Failover redundancy". Default: false.
	redis.lock.keyPrefix           -- Default: 'push_lock_'.
	redis.lock.lockTimeout         -- Milliseconds. Default: 5000.
	redis.lock.maxAttempts         -- Default: 5.

	apns                           -- Set to false to disable APNS. APNS is also disabled when no
	                                  certificate is given.
	apns.certificate               -- Path to a .p12 (PKCS #12) file, or its contents as a Buffer.
	apns.passphrase                -- The certificate's passphrase, if any.
	apns.gateway.address           -- Default: 'gateway.push.apple.com'.
	                                  Use 'gateway.sandbox.push.apple.com' for development.
	apns.gateway.connectionTimeout -- Milliseconds. Default: 240000. Any other `apns.gateway` key is
	                                  passed to apn.Connection.
	apns.feedback.enabled          -- Default: true.
	apns.feedback.address          -- Default: 'feedback.push.apple.com'.
	                                  Use 'feedback.sandbox.push.apple.com' for development.
	apns.feedback.interval         -- Polling interval in seconds. Default: 300.

	gcm                            -- Set to false to disable GCM. GCM is also disabled when no key
	                                  is given.
	gcm.options.key                -- Your GCM API key.
	gcm.options.retries            -- Default: 3.

### Sharding

You can split the workload across multiple instances by giving each one a
different `redis.channels`.

### Failover redundancy

Multiple instances can subscribe to the same channel(s) at the same time. A
Redis lock keyed on the message `identifier` makes sure only one of them sends
each message. All instances sharing the same channel(s) must use the same
`redis.lock.keyPrefix` and set `redis.failoverEnabled` to `true`.

### What redis-pusher does not attempt to do

It doesn't decide what to do with APNS feedback or GCM "not registered" replies.
That depends on your setup (an SQL table of devices, for example). It emits the
`feedback`, `transmissionError` and `registrationUpdated` events, and you decide
what to do with them.

## Usage as a standalone service (CLI)

The package also installs a `redis-pusher` command. It takes a config file that
exports the same options object, plus an optional `catchExceptions` flag:

	$ redis-pusher path/to/config.js

Without an argument, it loads `./private/config.<NODE_ENV>.js` (NODE_ENV
defaults to `development`):

	$ cp -ir node_modules/redis-pusher/examples/config private
	$ chmod 700 private
	$ $EDITOR private/config.development.js
	$ NODE_ENV=development redis-pusher

The CLI logs to the console and prints the devices reported by the APNS
feedback service. Stop it with Ctrl-C or SIGTERM.

## Message format for iOS (APNS)

	message {
		identifier: [string]               -- Unique identifier. Required for messages published via Redis
		                                      (it's the lock key).
		token: [string or array of string] -- Required. The APNS device token of a recipient device, or
		                                      an array of them.
		expiry: [number]                   -- Seconds from now.
		badge: [number]
		sound: [string]
		alert: [string]
		payload: [object]
		retryLimit: [number]               -- Optional. The maximum number of retries if an error occurs
		                                      when sending a notification. A value of 0 will attempt
		                                      sending only once (0 retries).
	}

## Message format for Android (GCM)

	message {
		identifier: [string]                        -- Unique identifier. Required for messages published
		                                               via Redis (it's the lock key).
		registrationId: [string or array of string] -- Required. The GCM registration ID of a recipient
		                                               device, or an array of them (up to 1000). Sending
		                                               to several registration IDs is called a multicast
		                                               message.
		collapseKey: [string]                       -- Optional. If there's an older message with the
		                                               same collapseKey and registration ID, the older
		                                               message is discarded and the new one takes its
		                                               place.
		delayWhileIdle: [boolean]                   -- Optional. Default is false. If the device is
		                                               connected but idle, the message is delivered
		                                               right away unless delayWhileIdle is true. If it
		                                               is true, the message is stored on the GCM servers
		                                               until the device wakes up.
		timeToLive: [number:0..2419200]             -- Optional. How long (in seconds) the message should
		                                               be kept on GCM storage if the device is offline.
		                                               Requests without this field default to the
		                                               maximum of 4 weeks. When a message times out,
		                                               it's discarded from GCM storage.
		data: [object]                              -- Optional. Custom data.
	}
