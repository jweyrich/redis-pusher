# redis-pusher

A Node.js application that consumes messages published on Redis channels and
send them as Push Notifications via APNS or GCM.

1. Workflow

	a) Events: Sit and listen for messages published on the Redis subscribed
	   channel(s).

	b) Processing: Convert each published message to the APNS or GCM message format
	   and dispatch them to the APNS or GCM server.

	c) Feedback: Periodically connect to the APNS Feedback server, and receive a
	   list of devices that have persistent delivery failures so that you can
	   mark them as bad and refrain from sending new push notifications to them.

2. Sharding

	You can split the workload across multiple `redis-pusher` instances.
	To do that, configure `config.redis.channels` in your configuration file so
	that each `redis-pusher` instance subscribes to different channel(s).

3. Failover redundancy

	You may have multipe instances subscribed to the same channel(s)
	simultaneously. To do that, all your instances sharing the same channel(s)
	must specify the same value for `config.redis.lock.keyPrefix` and set
	`config.redis.failoverEnabled` to `true`.

4. Configuration

	Each configuration file may be considered an environment (e.g.: development,
	production, etc). A new configuration file can extend an existing
	configuration by adding these lines before anything else:

		var config = module.exports = require('./another_existing_file')
		var this_config_name = 'example';
		config.loaded.push(this_config_name);

	To switch between environments (configurations), specify
	`NODE_ENV=<env_name>` when running `redis-pusher`. Example:

		NODE_ENV=production node .

	The example above will load `./private/config.production.js`.

5. What `redis-pusher` does not attempt to do

	It does not process any of the APNS feedback messages. It also does not handle
	GCM replies that tell you the device is not (or no longer) registered.
	This is something specific to your scenario. For example, your scenario might
	involve an SQL table containing all registered devices (id, device_token, etc),
	so you could mark them as bad, or simply delete them. It's entirely up to you!

- - -

### How can I test it?

##### Install the required tools

1. [Node.js](http://nodejs.org/)
2. [Redis](http://redis.io/)

##### Clone the repository

	$ git clone https://github.com/jweyrich/redis-pusher.git

##### Install the dependencies

	$ cd redis-pusher
	$ npm install

##### Test locally

###### Configure

a) Copy your APNS certificates and keys to the private
   directory that resides within the project's directory:

	$ cp -i /path/to/your/apns_development.p12 \
		/path/to/your/apns_production.p12 \
		private/

b) Copy the example configuration files to the project's `private`
   directory:

	$ cp -ir examples/config/* private/

c) Make sure nobody else can read the contents of your private directory:

	$ chmod 700 private

d) Edit your private configuration files according to your needs:

	config.redis.host          -- The host your Redis instance is running.
	config.redis.port          -- The port your Redis instance is listening.
	config.redis.pass          -- The password to your Redis instance.
	                              Please, set to '' if you don't need it.
	config.redis.channels      -- Which redis channels `redis-pusher` will listen to.
	                              IMPORTANT: The current version of `redis-pusher` can only distinguish
	                              APNS messages from GCM messages using the channel name. Channel names
	                              for APNS must contain one of ['apns','ios','iphone','ipad'], and
	                              channel names for GCM must contain one of ['gcm','android'].
	                              "ABSURD!" you scream. Right! I just haven't had the time to come up
	                              with a clean solution.

	config.apns.certificate    -- The APNS certificate file in .p12 (PKCS #12) format.
	config.apns.passphrase     -- The passphrase for your APNS certificate file.
	                              Please, set to `undefined` if you don't need it.

	config.gcm.options.key     -- Your GCM API key.

###### Run it

	$ NODE_ENV=development node . &
	$ redis-cli
	redis> publish development:push:ios '{ "identifier": "a-unique-identifier", "tokens": [ <device_token>, <anoter_device_token>, ... ], "expires": 300, "badge": 1, "sound": "default", "alert": "You have a new message" }'
	redis> publish development:push:android '{ "identifier": "another-unique-identifier", "registrationId": [ [ <registration_id>, <another_registration_id>, ... ], "collapseKey": "status", "delayWhileIdle": false, "timeToLive": 300, "data": {  "key1": "foo", "key2": "bar" } }'

##### Message format for iOS

	message {
		identifier: [string]               -- Required. Unique identifier.
		token: [string or array of string] -- Required. The APNS device token of a recipient device, or
		                                      an array of them for sending to 1 or more (up to ???).
		expires: [number]                  -- Seconds from now.
		badge: [number]
		sound: [string]
		alert: [string]
		payload: [object]
		retryLimit: [number]               -- Optional. The maximum number of retries if an error occurs
		                                      when sending a notification. A value of 0 will attempt
		                                      sending only once (0 retries).
	}

##### Message format for Android

	message {
		identifier: [string]                        -- Required. Unique identifier.
		registrationId: [string or array of string] -- Required. The GCM registration ID of a recipient
		                                               device, or an array of them for sending to 1 or
		                                               more devices (up to 1000). When you send a message
		                                               to multiple registration IDs, that is called a
		                                               multicast message.
		collapseKey: [string]                       -- Optional. If there's an older message with the
		                                               same collapseKey and registration ID, the older
		                                               message will be discarded and the new one will
		                                               take its place.
		delayWhileIdle: [boolean]                   -- Optional. Default is false. If the device is
		                                               connected but idle, the message will still be
		                                               delivered right away unless the delay_while_idle
		                                               flag is set to true. Otherwise, it will be stored
		                                               in the GCM servers until the device is awake.
		timeToLive: [number:0..2419200]             -- Optional. How long (in seconds) the message should
		                                               be kept on GCM storage if the device is offline.
		                                               Requests that don't contain this field default to
		                                               the maximum period of 4 weeks. When a message
		                                               times out, it will be discarded from the GCM
		                                               storage.
		data: [object]                              -- Optional. Custom data.
	}
