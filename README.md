# redis-pusher

A Node.js library (and CLI) that consumes messages published on Redis channels
and sends them as push notifications via Apple Push Notification service (APNS)
and Firebase Cloud Messaging (FCM).

- **Events**: listens for messages published on the configured Redis channel(s).
- **Delivery**: sends each message through APNS's HTTP/2 API or the FCM HTTP v1
  API, retrying transient failures.
- **Dead devices**: tells you when Apple or Google report that a device token is
  no longer valid, so you can stop pushing to it.

It has no APNS/FCM SDK dependencies: both protocols are implemented on Node's
built-in `http2` and `crypto` modules.

## Install

Requires Node.js 22 or later.

	$ npm install redis-pusher

## Credentials

**APNS.** Token-based auth is recommended. In your Apple developer account, create
a key with the "Apple Push Notifications service (APNs)" capability and download
the `.p8` file. Note its Key ID and your Team ID. Certificate-based auth with a
`.p12` file is also supported.

**FCM.** In the Firebase console, go to Project settings > Service accounts and
generate a new private key. That downloads the service account JSON file.

## Usage as a library

```js
const RedisPusher = require('redis-pusher');

const pusher = RedisPusher({
	logger: console, // Optional. Silent by default.
	redis: {
		host: '127.0.0.1',
		port: 6379,
		channels: {
			'push:ios': 'apns',
			'push:android': 'fcm'
		}
	},
	apns: {
		key: '/path/to/AuthKey_ABC123DEFG.p8',
		keyId: 'ABC123DEFG',
		teamId: 'DEF123GHIJ',
		topic: 'com.example.app', // Your app's bundle ID.
		production: true          // false for the sandbox (development builds).
	},
	fcm: {
		serviceAccount: '/path/to/service-account.json'
	}
});

pusher.on('error', (err) => {
	// Connection/credential errors. `err.source` is one of 'redis-client',
	// 'redis-subscriber', 'redis-lock', 'apns', 'fcm' or 'fcm-auth'.
	console.error(err.source, err);
});

pusher.on('unregistered', (result) => {
	// Apple or Google say this device token is no longer valid.
	db.removeDeviceToken(result.platform, result.recipient);
});

pusher.on('transmissionError', (result) => {
	// result: { platform, recipient, ok: false, status, error, ... }
	console.warn('Push failed', result.platform, result.recipient, result.error);
});

pusher.start((err) => {
	if (err) throw err;
	console.log('Listening for push messages');
});

// Later:
pusher.stop(() => console.log('Stopped'));
```

Then publish messages from anywhere:

	redis> publish push:ios '{ "identifier": "msg-1", "token": "<device_token>", "alert": "Hello!" }'
	redis> publish push:android '{ "identifier": "msg-2", "token": "<registration_token>", "notification": { "title": "Hello!" } }'

### Sending without Redis

`send()` delivers a notification immediately. It doesn't need `start()`, a
Redis connection or a lock. It returns a Promise of one result per recipient:

```js
const pusher = RedisPusher({ fcm: { serviceAccount: '/path/to/service-account.json' } });

const results = await pusher.send('fcm', {
	token: [ 'token1', 'token2' ],
	notification: { title: 'Hello', body: 'World' },
	data: { orderId: '123' }
});
// [ { platform: 'fcm', recipient: 'token1', ok: true, id: 'projects/.../messages/...' },
//   { platform: 'fcm', recipient: 'token2', ok: false, status: 404, error: 'UNREGISTERED', unregistered: true, ... } ]
```

Or with a callback: `pusher.send('fcm', message, (err, results) => { ... })`.

A failed delivery is a result with `ok: false`, not a rejection. The Promise only
rejects (or the callback gets `err`) when the message is invalid or the platform
isn't configured.

A script that only calls `send()` exits once its pushes complete. You don't need
to call `stop()`.

### API

#### `RedisPusher(options)` / `new RedisPusher(options)` / `RedisPusher.createPusher(options)`

Creates a pusher. Reads and checks the credentials immediately, and throws if
they are missing or invalid, or if the options are inconsistent (for example, a
channel mapped to a platform that isn't configured). It doesn't connect to
anything until it's used.

#### `pusher.start([callback])`

Connects to Redis and subscribes to `redis.channels`. Calls `callback(err)` once
subscribed.

#### `pusher.stop([callback])`

Unsubscribes and closes the Redis, APNS and FCM connections, letting in-flight
pushes finish. Calls `callback(err)` once everything is closed. `send()` still
works after `stop()`, and opens new connections.

#### `pusher.send(platform, message[, callback])`

Sends `message` (a JSON string, a plain object, or an `APNSMessage`/`FCMMessage`)
via `platform` (`'apns'` or `'fcm'`). See "Sending without Redis".

#### Results

Each recipient gets one result:

| Field          | Meaning                                                                                 |
|----------------|-----------------------------------------------------------------------------------------|
| `platform`     | `'apns'` or `'fcm'`.                                                                    |
| `recipient`    | The device token.                                                                       |
| `ok`           | `true` if Apple/Google accepted the notification.                                       |
| `id`           | The `apns-id`, or the FCM message name.                                                 |
| `status`       | The HTTP status, when the failure came from the server.                                 |
| `error`        | The APNS `reason` (e.g. `BadDeviceToken`), the FCM error code (e.g. `UNREGISTERED`), or a network error code (e.g. `ECONNREFUSED`). |
| `unregistered` | `true` when the token is no longer valid (APNS 410, FCM `UNREGISTERED`).                |
| `time`         | APNS only: when Apple last knew the token was valid.                                    |
| `message`      | FCM only: the server's error description.                                               |

Rate limits (429), server errors (5xx), expired auth tokens and network errors
are retried with exponential backoff (see the `retries` and `retryDelay`
options) before a failure is reported.

#### Events

| Event               | Arguments               | When                                                          |
|---------------------|-------------------------|---------------------------------------------------------------|
| `ready`             | –                       | Subscribed to all configured channels.                        |
| `message`           | `(message, channel)`    | A valid message was received from Redis.                      |
| `invalid`           | `(error, channel, raw)` | A message from Redis was rejected (bad JSON, missing fields). |
| `sent`              | `(message, results)`    | Delivery was attempted for every recipient of a message.      |
| `transmitted`       | `(result)`              | Accepted for a device.                                        |
| `transmissionError` | `(result)`              | Failed for a device, after retries.                           |
| `unregistered`      | `(result)`              | The device token is no longer valid, so stop sending to it. Also emitted as `transmissionError`. |
| `error`             | `(error)`               | Connection/credential errors. See `error.source`.             |

As with any Node.js `EventEmitter`, an `error` event with no listener throws.
**Always listen for `error`.**

#### Other exports

- `RedisPusher.APNSMessage`, `RedisPusher.FCMMessage`: the message classes.
- `RedisPusher.createMessage(platform, data)`: builds and validates a message, or throws.
- `RedisPusher.defaults`: the default options (read-only).

### Options

Anything you don't set falls back to its default.

#### General

| Option   | Default | Description                                         |
|----------|---------|-----------------------------------------------------|
| `logger` | silent  | Any object with console-like `log`, `warn` and `error` methods, e.g. `console`. |

#### Redis

| Option                  | Default        | Description |
|-------------------------|----------------|-------------|
| `redis.url`             | –              | e.g. `'redis://user:secret@host:6379/0'`, or `'rediss://...'` for TLS. Takes precedence over `host` and `port`. |
| `redis.host`            | `'127.0.0.1'`  | |
| `redis.port`            | `6379`         | |
| `redis.username`        | –              | Redis 6+ ACL user. |
| `redis.password`        | –              | `redis.pass` is accepted too. |
| `redis.options`         | `{}`           | Passed to `createClient()` from [`@redis/client`](https://www.npmjs.com/package/@redis/client), e.g. `{ database: 2, socket: { tls: true } }`. |
| `redis.channels`        | `[]`           | Channels to subscribe to. Either an object mapping each channel to its platform, e.g. `{ 'push:ios': 'apns', 'push:android': 'fcm' }`, or an array of names, in which case the platform is guessed from the name: `apns`, `ios`, `iphone` or `ipad` → APNS, and `fcm`, `gcm` or `android` → FCM. |
| `redis.failoverEnabled` | `false`        | See "Failover redundancy". |
| `redis.lock.keyPrefix`  | `'push_lock_'` | |
| `redis.lock.lockTimeout`| `5000`         | Milliseconds. How long a lock outlives an instance that died while holding it, and how often standby instances check on it. |
| `redis.lock.maxAttempts`| `5`            | With failover, how many instances may try to deliver the same message in turn. |

#### APNS

Set `apns` to `false` to disable APNS. It's also disabled when neither a key nor
a certificate is given. Use either `key` + `keyId` + `teamId` (token-based auth)
or `certificate` (certificate-based auth).

| Option                | Default | Description |
|-----------------------|---------|-------------|
| `apns.key`            | –       | Token-based auth: path to the `.p8` key, or its PEM contents. |
| `apns.keyId`          | –       | Required with `apns.key`. |
| `apns.teamId`         | –       | Required with `apns.key`. |
| `apns.certificate`    | –       | Certificate-based auth: path to a `.p12` file, or its contents as a Buffer. |
| `apns.passphrase`     | –       | The certificate's passphrase, if any. |
| `apns.topic`          | –       | Your app's bundle ID. Required with `apns.key`. A message's own `topic` overrides it. |
| `apns.production`     | `true`  | `true` uses `api.push.apple.com`. `false` uses `api.sandbox.push.apple.com`. |
| `apns.port`           | `443`   | `443` or `2197`. |
| `apns.url`            | –       | Overrides the server URL entirely (e.g. for testing). |
| `apns.concurrency`    | `100`   | Max concurrent requests. |
| `apns.requestTimeout` | `10000` | Milliseconds. |
| `apns.retries`        | `3`     | Retries for rate limits, server errors and network errors. |
| `apns.retryDelay`     | `500`   | Initial backoff in milliseconds, doubled on each retry. |

#### FCM

Set `fcm` to `false` to disable FCM. It's also disabled when no service account
is given.

| Option               | Default                        | Description |
|----------------------|--------------------------------|-------------|
| `fcm.serviceAccount` | –                              | Path to the service account JSON key file, or its parsed contents. |
| `fcm.projectId`      | the service account's `project_id` | |
| `fcm.url`            | `'https://fcm.googleapis.com'` | Overrides the server URL (e.g. for testing). |
| `fcm.concurrency`    | `100`                          | Max concurrent requests. |
| `fcm.requestTimeout` | `10000`                        | Milliseconds. |
| `fcm.retries`        | `3`                            | Retries for rate limits, server errors and network errors. |
| `fcm.retryDelay`     | `500`                          | Initial backoff in milliseconds, doubled on each retry. |

### Sharding

You can split the workload across multiple instances by giving each one a
different `redis.channels`.

### Failover redundancy

Multiple instances can subscribe to the same channel(s) at the same time. All
instances sharing the same channel(s) must use the same `redis.lock.keyPrefix`
and set `redis.failoverEnabled` to `true`.

A Redis lock keyed on the message `identifier` makes sure only one of them sends
each message:

- The instance that gets the lock delivers the message, and keeps renewing the
  lock while it works, however long that takes.
- The others wait as standbys and check the lock every `redis.lock.lockTimeout`.
- If the instance holding the lock dies, the lock expires within
  `lockTimeout`, and a standby takes over and delivers the message. This repeats
  up to `redis.lock.maxAttempts` times.
- Once a message has been delivered, the lock is marked as done for
  `lockTimeout × (maxAttempts + 1)`, so late standbys skip it. Publishing the same
  `identifier` again within that window is ignored.

Without failover, instances that don't get the lock simply skip the message,
and the lock is released as soon as delivery has been attempted.

### What redis-pusher does not attempt to do

It doesn't store device tokens or decide what to do with dead ones. That
depends on your setup (an SQL table of devices, for example). It emits the
`unregistered` and `transmissionError` events, and you decide what to do with
them.

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

The CLI logs to the console and prints the devices reported as unregistered.
Stop it with Ctrl-C or SIGTERM.

## Message format for iOS (APNS)

	message {
		identifier: [string]               -- Unique identifier. Required for messages published via Redis
		                                      (it's the lock key).
		token: [string or array of string] -- Required. The hex device token(s).
		alert: [string or object]          -- e.g. "Hello" or { "title": "...", "body": "..." }
		badge: [number]
		sound: [string or object]
		category: [string]
		threadId: [string]
		contentAvailable: [boolean]        -- A background (silent) push when there's no alert/badge/sound.
		mutableContent: [boolean]
		payload: [object]                  -- Custom keys, sent next to `aps`.
		aps: [object]                      -- Extra `aps` keys, e.g. { "interruption-level": "time-sensitive" }.
		expiry: [number]                   -- Seconds from now. 0 means "deliver once, don't store".
		priority: [10, 5 or 1]             -- Default: 10, or 5 for background pushes.
		pushType: [string]                 -- Default: 'background' for silent pushes, else 'alert'.
		topic: [string]                    -- Overrides `apns.topic`.
		collapseId: [string]
	}

The JSON payload is limited to 4 KB.

## Message format for Android (FCM)

	message {
		identifier: [string]               -- Unique identifier. Required for messages published via Redis
		                                      (it's the lock key).
		token: [string or array of string] -- Required. The FCM registration token(s). `registrationId`
		                                      is accepted too.
		notification: [object]             -- { "title": "...", "body": "...", "image": "..." }
		data: [object]                     -- Custom data. FCM only accepts string values, so other
		                                      values are sent JSON-encoded.
		collapseKey: [string]              -- Newer messages replace older ones with the same key.
		timeToLive: [number:0..2419200]    -- Seconds to keep the message if the device is offline.
		priority: ['high' or 'normal']
		android: [object]                  -- These four are passed through to the FCM v1 message as-is,
		apns: [object]                        see https://firebase.google.com/docs/reference/fcm/rest/v1/projects.messages
		webpush: [object]
		fcmOptions: [object]
	}

## Migrating from 0.2

- **GCM is gone.** Google shut it down, so legacy server keys no longer work.
  Replace `gcm: { options: { key } }` with `fcm: { serviceAccount }`. The `'gcm'`
  platform name and the GCM message fields (`registrationId`, `collapseKey`,
  `timeToLive`, `data`) still work. `delayWhileIdle` is ignored.
- **APNS uses the HTTP/2 API.** A `.p12` certificate still works. Add `topic`,
  and set `production: false` for the sandbox (a legacy sandbox
  `gateway.address` is still recognised). Device tokens must be hex strings.
- **The `feedback` and `registrationUpdated` events are gone.** Apple retired the
  feedback service, and FCM v1 has no canonical IDs. Listen for `unregistered`.
- **`send()` returns a Promise of results** instead of the message.
- **Redis client.** redis-pusher now uses the current Redis client
  ([`@redis/client`](https://www.npmjs.com/package/@redis/client)) instead of
  `redis@0.8`. `redis.host`, `redis.port` and `redis.pass` work as before, and
  `redis.url`, `redis.username` and `redis.password` are new. If you set
  `redis.options`, they are now passed to the new client.
- **Node.js 22 or later is required.**

## Running the tests

	$ npm install
	$ npm test

The tests never contact Apple or Google. They run against local mock APNS and FCM
servers that check JWT signatures, request paths and headers the way the real
services do. The integration tests also start a throwaway `redis-server` on a
free port, and are skipped if `redis-server` isn't installed. To use an existing
server instead, set `REDIS_PORT` (the tests flush its current database).
