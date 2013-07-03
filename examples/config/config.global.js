//
// GLOBAL CONFIGURATIONS
//

var config = module.exports = require('./config.defaults');
var this_config_name = 'global';
config.loaded.push(this_config_name);

//
// Redis
//
config.redis.failoverEnabled = false;
config.redis.host = '127.0.0.1';
config.redis.port = 6379;
config.redis.pass = '';
config.redis.lock.keyPrefix = 'push_lock_';
