'use strict';
//
// Shared test helpers.
//

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');
const notify = require('push-notify');

// Replace the APNS/GCM senders' `send()` so nothing hits the network.
// Each call is recorded as { sender, message }; tests can make the sender
// emit events (e.g. `call.sender.emit('transmitted', ...)`) to simulate replies.
function stubSenders() {
	const sent = { apns: [], gcm: [] };
	const original = {
		apns: notify.apn.Sender.prototype.send,
		gcm: notify.gcm.Sender.prototype.send
	};
	notify.apn.Sender.prototype.send = function (message) { sent.apns.push({ sender: this, message }); };
	notify.gcm.Sender.prototype.send = function (message) { sent.gcm.push({ sender: this, message }); };
	sent.reset = () => { sent.apns.length = 0; sent.gcm.length = 0; };
	sent.restore = () => {
		notify.apn.Sender.prototype.send = original.apns;
		notify.gcm.Sender.prototype.send = original.gcm;
	};
	return sent;
}

// Resolve once `predicate()` is truthy, or reject after `timeout` ms.
function eventually(predicate, timeout = 3000, interval = 20) {
	const deadline = Date.now() + timeout;
	return new Promise((resolve, reject) => {
		(function check() {
			let value;
			try { value = predicate(); } catch (err) { return reject(err); }
			if (value) return resolve(value);
			if (Date.now() > deadline) return reject(new Error('Timed out waiting for condition: ' + predicate));
			setTimeout(check, interval);
		})();
	});
}

function freePort() {
	return new Promise((resolve, reject) => {
		const server = net.createServer();
		server.unref();
		server.on('error', reject);
		server.listen(0, '127.0.0.1', () => {
			const { port } = server.address();
			server.close(() => resolve(port));
		});
	});
}

const redisAvailable = !!process.env.REDIS_PORT ||
	!spawnSync('redis-server', [ '--version' ]).error;

// Start a throwaway redis-server on a free port (no persistence), or reuse the
// one at $REDIS_PORT. Resolves to { port, client(), stop() }.
async function startRedis() {
	const redis = require('redis');

	if (process.env.REDIS_PORT) {
		const port = Number(process.env.REDIS_PORT);
		return { port, client: () => redis.createClient(port, '127.0.0.1'), stop: async () => {} };
	}

	const port = await freePort();
	const child = spawn('redis-server', [
		'--port', String(port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no'
	], { stdio: [ 'ignore', 'pipe', 'pipe' ] });
	// Never leave a redis-server behind, even if the tests are interrupted.
	const kill = () => child.kill('SIGKILL');
	process.once('exit', kill);

	await new Promise((resolve, reject) => {
		let output = '';
		const timer = setTimeout(() => reject(new Error('redis-server did not start:\n' + output)), 5000);
		child.stdout.on('data', (chunk) => {
			output += chunk;
			if (/ready to accept connections/i.test(output)) {
				clearTimeout(timer);
				resolve();
			}
		});
		child.on('exit', (code) => {
			clearTimeout(timer);
			reject(new Error('redis-server exited with code ' + code + ':\n' + output));
		});
	});

	return {
		port,
		client: () => redis.createClient(port, '127.0.0.1'),
		stop: () => new Promise((resolve) => {
			process.removeListener('exit', kill);
			child.removeAllListeners('exit');
			child.once('exit', () => resolve());
			child.kill('SIGTERM');
		})
	};
}

// Promisified pusher.start()/stop(). start() fails instead of hanging if the
// pusher never becomes ready (e.g. a subscription that never completes).
const start = (pusher, timeout = 3000) => new Promise((resolve, reject) => {
	const timer = setTimeout(() => reject(new Error('Pusher did not become ready within ' + timeout + 'ms')), timeout);
	pusher.start((err) => {
		clearTimeout(timer);
		return err ? reject(err) : resolve();
	});
});
const stop = (pusher) => new Promise((resolve, reject) => pusher.stop((err) => err ? reject(err) : resolve()));

// Run a redis command on a redis@0.8 client and resolve with the reply.
// Falls back to send_command() for commands the old client has no method for.
const command = (client, name, ...args) => new Promise((resolve, reject) => {
	const callback = (err, reply) => err ? reject(err) : resolve(reply);
	if (typeof client[name] === 'function')
		client[name](...args, callback);
	else
		client.send_command(name, args, callback);
});

module.exports = { stubSenders, eventually, startRedis, redisAvailable, start, stop, command };
