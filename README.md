# redis-pusher

A Node.js application that consumes messages published on Redis channels and
send them as Push Notifications via APNS.

1. Workflow

	a) Events: Sit and listen for messages published on the Redis subscribed
	   channel(s).

	b) Processing: Convert each published message to the APNS message format
	   and dispatch them to the APNS server.

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

	It does not process any of the APNS feedback messages. This is something
	specific to your scenario. For example, your scenario might involve an SQL
	table containing all registered devices (id, device_token, etc), so you
	could mark them as bad, or simply delete them. It's entirely up to you!

- - -

### How can I test it?

##### Install the required tools

1. [Node.js](http://nodejs.org/)
2. [Redis](http://redis.io/)

##### Clone the repository

	$ git clone git@github.com:jweyrich/redis-pusher.git

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

	config.redis.host
	config.redis.port
	config.redis.pass
	config.redis.channels
	config.apns.certificate
	config.apns.passphrase

###### Run it

	$ NODE_ENV=development node . &
	$ redis-cli
	redis> publish development:push:ios '{ "identifier": "a-unique-identifier", "device_token": "<device_token>", "expires": 300, "badge": 1, "sound": "default", "alert": "You have a new message" }'

##### Message format

	message {
		identifier: [string] -- Unique identifier
		device_token: [string]
		expires: [number] -- Seconds from now
		badge: [number]
		sound: [string]
		alert: [string]
		payload: [object]
	}
