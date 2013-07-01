//
// CONFIGURATION
//
module.exports = {
	development: {
		catchExceptions: false,
		redis: {
			// Enable if you're running multiple instances on the same channel(s).
			failoverEnabled: false,
			host: '127.0.0.1',
			port: 6379,
			pass: '',
			//retry_max_delay: 1000 * 300, // 300 seconds.
			channels: [ 'push:ios' ],
			lock: {
				keyPrefix: 'push_lock_',
				lockTimeout: 5000, // 5 seconds.
				maxAttempts: 5
			}
		},
		apns: {
			gateway: {
				options: {
					pfx: 'private/aps_development.p12',
					passphrase: 'YOUR_APNS_DEVELOPMENT_PASSWORD',
					connectionTimeout: 1000 * 240, // 240 seconds.
					gateway: 'gateway.sandbox.push.apple.com' // Development
				}
			},
			feedback: {
				options: {
					pfx: 'private/aps_development.p12',
					passphrase: 'YOUR_APNS_DEVELOPMENT_PASSWORD',
					batchFeedback: true,
					interval: 300, // Pooling interval in seconds.
					address: 'feedback.sandbox.push.apple.com' // Development
				}
			}
		}
	},
	production: {
		catchExceptions: true,
		redis: {
			// Enable if you're running multiple instances on the same channel(s).
			failoverEnabled: false,
			host: 'YOUR_REDIS_HOST',
			port: 6379,
			pass: 'YOUR_REDIS_PASS',
			//retry_max_delay: 1000 * 300, // 300 seconds.
			channels: [ 'YOUR_CHANNEL_1', 'YOUR_CHANNEL_2' ],
			lock: {
				keyPrefix: 'push_lock_',
				lockTimeout: 5000, // 5 seconds.
				maxAttempts: 5
			}
		},
		apns: {
			gateway: {
				options: {
					pfx: 'private/aps_production.p12',
					passphrase: 'YOUR_APNS_PRODUCTION_PASSWORD',
					connectionTimeout: 1000 * 240, // 240 seconds.
					gateway: 'gateway.push.apple.com' // Development
				}
			},
			feedback: {
				options: {
					pfx: 'private/aps_production.p12',
					passphrase: 'YOUR_APNS_PRODUCTION_PASSWORD',
					batchFeedback: true,
					interval: 300, // Pooling interval in seconds.
					address: 'feedback.push.apple.com' // Development
				}
			}
		}
	}
};
