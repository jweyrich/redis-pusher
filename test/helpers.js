'use strict';
//
// Shared test helpers.
//

const { spawn, spawnSync } = require('node:child_process');
const net = require('node:net');

// Resolve once `predicate()` (which may be async) is truthy, or reject after `timeout` ms.
async function eventually(predicate, timeout = 3000, interval = 20) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await predicate();
		if (value)
			return value;
		if (Date.now() > deadline)
			throw new Error('Timed out waiting for condition: ' + predicate);
		await new Promise((resolve) => setTimeout(resolve, interval));
	}
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
// one at $REDIS_PORT. Resolves to { port, client(), stop() }, where `client()`
// resolves to a connected @redis/client.
async function startRedis() {
	const { createClient } = require('@redis/client');
	const connect = (port) => createClient({ socket: { host: '127.0.0.1', port } }).connect();

	if (process.env.REDIS_PORT) {
		const port = Number(process.env.REDIS_PORT);
		return { port, client: () => connect(port), stop: async () => {} };
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
		client: () => connect(port),
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

// Run a raw redis command, e.g. command(client, 'PUBSUB', 'NUMSUB', 'channel').
const command = (client, ...args) => client.sendCommand(args.map(String));

module.exports = { eventually, startRedis, redisAvailable, start, stop, command };
