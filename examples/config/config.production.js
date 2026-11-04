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
	'production:push:ios': 'apns',
	'production:push:android': 'fcm'
};

//
// APNS
//
config.apns = {
	key: 'private/AuthKey_<KEY_ID>.p8',
	keyId: '<CHANGEME>',
	teamId: '<CHANGEME>',
	topic: 'com.example.app',
	production: true
	// Or, with a certificate instead of a .p8 key:
	// certificate: 'private/aps_production.p12', passphrase: '<CHANGEME>', topic: 'com.example.app'
};

//
// FCM
//
config.fcm = {
	serviceAccount: 'private/firebase-service-account.json'
};
