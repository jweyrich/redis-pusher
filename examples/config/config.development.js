//
// DEVELOPMENT CONFIGURATIONS
//

var config = module.exports = require('./config.global');
var this_config_name = 'development';
config.loaded.push(this_config_name);

//
// Redis
//
config.redis.channels = [ 'development:push:ios', 'development:push:android' ];

//
// APNS
//
config.apns.gateway.address = 'gateway.sandbox.push.apple.com'; // Development
config.apns.feedback.address = 'feedback.sandbox.push.apple.com'; // Development
certArray = [];
certArray['<APP_NAME>'] = {};
certArray['<APP_NAME>'].certificate = 'private/aps_development.p12';
certArray['<APP_NAME>'].passphrase = '<CHANGEME>';
config.apns.certArray = certArray;

//
// GCM
//
config.gcm.options.key = '<CHANGEME>'; // API key

