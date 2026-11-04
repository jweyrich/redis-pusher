'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { startRedis, redisAvailable, eventually } = require('./helpers');

const BIN = path.join(__dirname, '..', 'bin', 'redis-pusher.js');

function run(args, options) {
	const child = spawn(process.execPath, [ BIN, ...args ], Object.assign({ stdio: [ 'ignore', 'pipe', 'pipe' ] }, options));
	child.output = '';
	child.stdout.on('data', (chunk) => { child.output += chunk; });
	child.stderr.on('data', (chunk) => { child.output += chunk; });
	child.exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
	return child;
}

describe('redis-pusher CLI', { timeout: 30000 }, () => {
	let dir;
	before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'redis-pusher-cli-')); });
	after(() => fs.rmSync(dir, { recursive: true, force: true }));

	function writeConfig(name, config) {
		const file = path.join(dir, name);
		fs.writeFileSync(file, 'module.exports = ' + JSON.stringify(config) + ';\n');
		return file;
	}

	it('exits with an error when the config file does not exist', async () => {
		const child = run([ path.join(dir, 'missing.js') ]);
		assert.deepEqual(await child.exited, { code: 1, signal: null });
		assert.match(child.output, /Unable to load config file/);
	});

	it('exits with an error on an invalid configuration', async () => {
		const child = run([ writeConfig('bad.js', { redis: { channels: [ 'whatever' ] } }) ]);
		assert.deepEqual(await child.exited, { code: 1, signal: null });
		assert.match(child.output, /Invalid configuration: Cannot tell which platform/);
	});

	it('loads ./private/config.<NODE_ENV>.js when no file is given', async () => {
		fs.mkdirSync(path.join(dir, 'private'), { recursive: true });
		writeConfig(path.join('private', 'config.staging.js'), { redis: { channels: [] } });
		const child = run([], { cwd: dir, env: Object.assign({}, process.env, { NODE_ENV: 'staging' }) });
		assert.deepEqual(await child.exited, { code: 1, signal: null });
		assert.match(child.output, /config\.staging\.js/);
		assert.match(child.output, /No channels configured/);
	});

	describe('with Redis', { skip: !redisAvailable && 'redis-server is not installed', timeout: 30000 }, () => {
		let server;
		before(async () => { server = await startRedis(); });
		after(async () => { await server.stop(); });

		it('subscribes, then shuts down cleanly on SIGTERM', async () => {
			const config = writeConfig('good.js', {
				redis: { port: server.port, channels: { 'cli:android': 'gcm' } },
				gcm: { options: { key: 'key' } }
			});
			const child = run([ config ]);
			await eventually(() => /Subscribed to 'cli:android'/.test(child.output), 5000);
			child.kill('SIGTERM');
			assert.deepEqual(await child.exited, { code: 0, signal: null });
			assert.match(child.output, /Shutting down/);
		});
	});
});
