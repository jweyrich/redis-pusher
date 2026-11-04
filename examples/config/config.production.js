//
// PRODUCTION CONFIGURATIONS
//

var config = module.exports = require('./config.global');

//
// Core (only used by the redis-pusher CLI)
//
config.catchExceptions = true;

//
// Redis
//
config.redis.channels = {
	'production:push:ios': 'apns'
};

//
// APNS
//
config.apns = {
	certificate: 'private/aps_production.p12', // Path or Buffer.
	passphrase: '<CHANGEME>',
	gateway: { address: 'gateway.push.apple.com' },
	feedback: { address: 'feedback.push.apple.com' }
};

//
// GCM -- disabled in this environment.
//
config.gcm = false;
