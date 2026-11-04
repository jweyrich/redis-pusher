'use strict';

const http2 = require('http2');

//
// A small HTTP/2 client: one long-lived session per origin (reconnected on
// demand), a cap on concurrent streams, per-request timeouts, and it only
// keeps the process alive while requests are in flight.
//
class Http2Client {
	constructor(origin, { tls = {}, concurrency = 100, requestTimeout = 10000, logger, name = origin } = {}) {
		this.origin = origin;
		this.tls = tls;
		this.concurrency = concurrency;
		this.requestTimeout = requestTimeout;
		this.logger = logger;
		this.name = name;
		this.session = null;
		this.active = 0;
		this.queue = [];
		this.closed = false;
	}

	// Resolves to { status, headers, body } for any HTTP status. Rejects on
	// network errors and timeouts.
	request(options) {
		if (this.closed)
			return Promise.reject(Object.assign(new Error(this.name + ' client is closed'), { code: 'ERR_CLIENT_CLOSED' }));
		return new Promise((resolve, reject) => {
			this.queue.push({ options, resolve, reject });
			this._drain();
		});
	}

	close() {
		this.closed = true;
		const pending = this.queue.splice(0);
		pending.forEach(({ reject }) => reject(Object.assign(new Error(this.name + ' client is closed'), { code: 'ERR_CLIENT_CLOSED' })));
		const session = this.session;
		this.session = null;
		if (!session || session.closed || session.destroyed)
			return Promise.resolve();
		session.ref();
		// Waits for in-flight streams to finish.
		return new Promise((resolve) => session.close(resolve));
	}

	_drain() {
		while (this.active < this.concurrency && this.queue.length > 0) {
			const task = this.queue.shift();
			this._run(task.options).then(task.resolve, task.reject);
		}
	}

	_session() {
		const current = this.session;
		if (current && !current.closed && !current.destroyed)
			return current;

		const session = http2.connect(this.origin, this.tls);
		session.on('error', (err) => {
			// Streams on this session fail with their own errors; just log here.
			if (this.logger)
				this.logger.error('[%s] Connection error: %s', this.name, err.message);
		});
		session.on('goaway', () => {
			if (this.session === session)
				this.session = null;
		});
		session.on('close', () => {
			if (this.session === session)
				this.session = null;
		});
		session.unref();
		this.session = session;
		return session;
	}

	_run({ method = 'POST', path, headers = {}, body }) {
		return new Promise((resolve, reject) => {
			let session, stream;
			let done = false;
			let response = null;
			const chunks = [];

			const finish = (err) => {
				if (done)
					return;
				done = true;
				this.active--;
				if (this.active === 0 && !session.destroyed)
					session.unref();
				if (err)
					reject(err);
				else
					resolve({ status: response[':status'], headers: response, body: chunks.join('') });
				this._drain();
			};

			this.active++;
			try {
				session = this._session();
				session.ref();
				stream = session.request(Object.assign({ ':method': method, ':path': path }, headers));
			} catch (err) {
				session = session || { destroyed: true };
				return finish(err);
			}

			stream.setEncoding('utf8');
			stream.setTimeout(this.requestTimeout, () => {
				stream.close(http2.constants.NGHTTP2_CANCEL);
				finish(Object.assign(new Error('Request timed out after ' + this.requestTimeout + 'ms'), { code: 'ETIMEDOUT' }));
			});
			// 'end' and 'error' arrive in a different order across Node versions,
			// so 'close' (always last) settles anything they didn't.
			let streamError = null;
			stream.on('response', (h) => { response = h; });
			stream.on('data', (chunk) => chunks.push(chunk));
			stream.on('end', () => {
				if (response)
					finish(null);
			});
			stream.on('error', (err) => {
				// A failed connection surfaces as ERR_HTTP2_STREAM_CANCEL; report the
				// underlying cause (e.g. ECONNREFUSED) instead.
				streamError = err.code === 'ERR_HTTP2_STREAM_CANCEL' && err.cause ? err.cause : err;
			});
			stream.on('close', () => {
				if (streamError)
					return finish(streamError);
				if (response)
					return finish(null);
				finish(Object.assign(new Error('Stream closed without a response (code ' + stream.rstCode + ')'), { code: 'ERR_STREAM_CLOSED' }));
			});
			stream.end(body);
		});
	}
}

module.exports = Http2Client;
