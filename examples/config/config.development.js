//
// DEVELOPMENT CONFIGURATIONS
//

var config = module.exports = require('./config.global');

//
// Redis
//
config.redis.channels = {
	'development:push:ios': 'apns',
	'development:push:android': 'gcm'
};

//
// APNS
//
config.apns = {
	certificate: 'private/aps_development.p12', // Path or Buffer.
	passphrase: '<CHANGEME>',
	gateway: { address: 'gateway.sandbox.push.apple.com' },
	feedback: { address: 'feedback.sandbox.push.apple.com' }
};

//
// GCM
//
config.gcm = {
	options: { key: '<CHANGEME>' } // API key
};
