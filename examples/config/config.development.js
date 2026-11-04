//
// DEVELOPMENT CONFIGURATIONS
//

var config = module.exports = require('./config.global');

//
// Redis
//
config.redis.channels = {
	'development:push:ios': 'apns',
	'development:push:android': 'fcm'
};

//
// APNS (token-based auth with a .p8 key from your Apple developer account)
//
config.apns = {
	key: 'private/AuthKey_<KEY_ID>.p8', // Path or PEM contents.
	keyId: '<CHANGEME>',
	teamId: '<CHANGEME>',
	topic: 'com.example.app',           // Your app's bundle ID.
	production: false                   // Use the sandbox.
};

//
// FCM (service account key from Firebase console > Project settings > Service accounts)
//
config.fcm = {
	serviceAccount: 'private/firebase-service-account.json' // Path or parsed JSON.
};
