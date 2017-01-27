//
// PRODUCTION CONFIGURATIONS
//

var config = module.exports = require('./config.global');
var this_config_name = 'production';
config.loaded.push(this_config_name);

//
// Core
//
config.catchExceptions = true;

//
// Redis
//
config.redis.channels = [ 'production:push:ios' ];

//
// APNS
//
config.apns.gateway.address = 'gateway.push.apple.com'; // Development
config.apns.feedback.address = 'feedback.push.apple.com'; // Development
certArray = [];
certArray['<APP_NAME>'] = {};
certArray['<APP_NAME>'].certificate = 'private/aps_development.p12';
certArray['<APP_NAME>'].passphrase = '<CHANGEME>';
config.apns.certArray = certArray;

//
// GCM
//
config.gcm.options.key = '<CHANGEME>'; // API key


