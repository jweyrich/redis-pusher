//
// GLOBAL CONFIGURATIONS
//
// Settings shared by every environment. Anything not set here falls back to
// the library defaults (see `require('redis-pusher').defaults`).
//

module.exports = {
	redis: {
		failoverEnabled: false,
		host: '127.0.0.1',
		port: 6379,
		pass: '',
		lock: {
			keyPrefix: 'push_lock_'
		}
	}
};
