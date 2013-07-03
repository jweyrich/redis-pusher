var environment = process.env.NODE_ENV || 'development';
var config = require("./private/config." + environment);
config.environment = environment;

var setup_apns_options = function () {
	// gateway -> gateway.options
	config.apns.gateway.options = config.apns.gateway;
	// feedback -> feedback.options
	config.apns.feedback.options = config.apns.feedback;
	// gateway.address -> gateway.options.gateway
	config.apns.gateway.options.gateway = config.apns.gateway.address;
	// certificate -> gateway.pfx
	config.apns.gateway.pfx = config.apns.certificate;
	// certificate -> feedback.pfx
	config.apns.feedback.pfx = config.apns.certificate;
	// passphrase -> gateway.passphrase
	config.apns.gateway.passphrase = config.apns.passphrase;
	// passphrase -> feedback.passphrase
	config.apns.feedback.passphrase = config.apns.passphrase;
};

setup_apns_options();

console.log('Running in ' + config.environment + ' [' + config.loaded.join(' -> ') + ']');

module.exports = config;
