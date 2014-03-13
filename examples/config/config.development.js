//
// DEVELOPMENT CONFIGURATIONS
//

var config = module.exports = require('./config.global');
var this_config_name = 'development';
config.loaded.push(this_config_name);

//
// Redis
//
config.redis.channels = [ 'development:push:ios' ];

//
// APNS
//
config.apns.certificate = 'private/aps_development.p12';
config.apns.passphrase = '<CHANGEME>';
config.apns.gateway.address = 'gateway.sandbox.push.apple.com'; // Development
config.apns.feedback.address = 'feedback.sandbox.push.apple.com'; // Development

//
// GCM
//
config.gcm.options.key = '<CHANGEME>'; // API key
