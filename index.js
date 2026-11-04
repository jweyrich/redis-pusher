var Pusher = require('./lib/pusher')
	, messages = require('./lib/messages')
	, options = require('./lib/options');

module.exports = Pusher;
module.exports.Pusher = Pusher;
module.exports.createPusher = function (opts) {
	return new Pusher(opts);
};
module.exports.APNSMessage = messages.APNSMessage;
module.exports.GCMMessage = messages.GCMMessage;
module.exports.createMessage = messages.create;
module.exports.defaults = options.DEFAULTS;
