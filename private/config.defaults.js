//
// DEFAULT CONFIGURATIONS
//

var config = module.exports = {};
config.loaded = config.loaded ? config.loaded : [];
var this_config_name = 'defaults';
config.loaded.push(this_config_name);

//
// Core
//
config.catchExceptions = false;

//
// Redis
//
config.redis = {};
config.redis.failoverEnabled = false;
config.redis.host = '<DEFAULT>';
config.redis.port = 6379;
config.redis.pass = '<DEFAULT>';
//config.redis.retry_max_delay = 1000 * 300; // 300 seconds.
config.redis.channels = [ '<DEFAULT>' ];
config.redis.lock = {};
config.redis.lock.keyPrefix = '<DEFAULT>';
config.redis.lock.lockTimeout = 5000; // 5 seconds.
config.redis.lock.maxAttempts = 5;

//
// APNS
//
config.apns = {};
config.apns.certificate = '<DEFAULT>'; // Only .p12 files
config.apns.passphrase = '<DEFAULT>';
config.apns.gateway = {};
config.apns.gateway.connectionTimeout = 1000 * 240; // 240 seconds.
config.apns.gateway.address = '<DEFAULT>';
config.apns.feedback = {};
config.apns.feedback.batchFeedback = true;
config.apns.feedback.interval = 300; // Pooling interval in seconds.
config.apns.feedback.address = '<DEFAULT>';

//
// GCM
//
config.gcm = {};
config.gcm.options = {};
config.gcm.options.key = '<DEFAULT>';
config.gcm.options.retries = 3;
config.gcm.options.proxy = undefined; // An HTTP proxy to be used. Supports proxy Auth with Basic Auth by embedding the auth info in the uri.
config.gcm.options.timeout = 180000; // Integer containing the number of milliseconds to wait for a request to respond before aborting the request.
