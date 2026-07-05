import { Context, Hono } from 'hono';
import crypto from 'node:crypto';
import {
	getBucket,
	getCacheControl,
	isMutablePath,
	isOverwritesEnabled,
	isPotentialMavenObjectPath,
	isValidatePathsEnabled,
} from './utils';

export const api = new Hono<{ Bindings: Env }>({ strict: false });

function returnCachedNotFound(c: Context) {
	const res = new Response('Not Found', {
		status: 404,
		headers: {
			'Cache-Control': 'public, max-age=120',
		},
	});
	const cache = caches.default;
	const putKey = new Request(c.req.url, { method: 'GET' });
	c.executionCtx.waitUntil(cache.put(putKey, res.clone()));
	return res;
}

api.on(['GET', 'HEAD'], '/:repo/*', async (c) => {
	const cache = caches.default;
	// Cloudflare Workers Cache API natively only supports caching GET requests
	// HEAD requests are not added to the cache, but we can extract the headers from a cached GET request
	const matchReq = new Request(c.req.raw, { method: 'GET' });
	const cachedResponse = await cache.match(matchReq);
	if (cachedResponse) {
		if (c.req.method === 'HEAD') {
			return new Response(null, { headers: cachedResponse.headers, status: cachedResponse.status });
		}
		return cachedResponse;
	}

	const repo = c.req.param('repo');
	const bucket = getBucket(c.env, repo);

	if (!bucket) {
		console.warn({ repo: repo, rejected: 'unknown bucket' });
		return returnCachedNotFound(c);
	}

	const path = c.req.path.substring(`/${repo}/`.length);
	if (!path) {
		console.warn({ path: path, rejected: 'empty path' });
		return c.text('Bad Request', 400);
	}

	if (isValidatePathsEnabled(c.env) && !isPotentialMavenObjectPath(path)) {
		console.warn({ path: path, rejected: 'invalid path' });
		return returnCachedNotFound(c);
	}

	const cacheControl = getCacheControl(path, c.env);

	if (c.req.method === 'HEAD') {
		const object = await bucket.head(path);
		if (!object) {
			console.warn({ path: path, rejected: 'object not found for HEAD' });
			return returnCachedNotFound(c);
		}

		const headers = new Headers();
		object.writeHttpMetadata(headers);
		headers.set('etag', object.httpEtag);
		headers.set('Accept-Ranges', 'bytes');
		headers.set('Content-Length', object.size.toString());
		headers.set('Cache-Control', cacheControl);
		return new Response(null, { headers });
	}

	// Handle Range requests
	const rangeHeader = c.req.header('Range');
	let options: R2GetOptions = {
		onlyIf: c.req.raw.headers,
	};
	let isRange = false;

	if (rangeHeader) {
		const match = rangeHeader.match(/^bytes=(\d*)-(\d*)$/);
		if (match) {
			isRange = true;
			const start = match[1] ? parseInt(match[1], 10) : undefined;
			const end = match[2] ? parseInt(match[2], 10) : undefined;
			if (start !== undefined && end !== undefined) {
				options.range = { offset: start, length: end - start + 1 };
			} else if (start !== undefined) {
				options.range = { offset: start };
			} else if (end !== undefined) {
				options.range = { suffix: end };
			}
		}
	}

	const object = await bucket.get(path, options);
	if (!object) {
		console.warn({ path: path, rejected: 'object not found for GET' });
		return returnCachedNotFound(c);
	}

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set('etag', object.httpEtag);
	headers.set('Accept-Ranges', 'bytes');
	headers.set('Cache-Control', cacheControl);

	// If the precondition fails, R2 returns an R2Object instead of R2ObjectBody.
	const hasBody = 'body' in object && object.body !== undefined;
	if (!hasBody) {
		let status = 304;
		// If-Match or If-Unmodified-Since failures result in 412 Precondition Failed
		if (c.req.header('if-match') || c.req.header('if-unmodified-since')) {
			status = 412;
		}

		console.warn({ path: path, rejected: 'no body for GET' });

		return new Response(null, {
			status,
			headers,
		});
	}

	let status = 200;
	if (isRange) {
		status = 206;
		// R2ObjectBody returned by get() with a range contains a 'range' property
		// with offset and length. If not, we can infer it.
		const returnedRange = (object as any).range || options.range;
		if (returnedRange) {
			let start = 0;
			let end = object.size - 1;
			if ('offset' in returnedRange && 'length' in returnedRange) {
				start = returnedRange.offset;
				end = start + returnedRange.length - 1;
			} else if ('offset' in returnedRange) {
				start = returnedRange.offset;
			} else if ('suffix' in returnedRange) {
				start = object.size - returnedRange.suffix;
			}
			headers.set('Content-Range', `bytes ${start}-${end}/${object.size}`);
			headers.set('Content-Length', (end - start + 1).toString());
		}
	} else {
		headers.set('Content-Length', object.size.toString());
	}

	const res = new Response(object.body, {
		status,
		headers,
	});

	if (status === 200) {
		const putKey = new Request(c.req.url, { method: 'GET' });
		c.executionCtx.waitUntil(cache.put(putKey, res.clone()));
	}

	return res;
});

api.put('/:repo/*', async (c) => {
	const repo = c.req.param('repo');
	const bucket = getBucket(c.env, repo);

	if (!bucket) {
		console.warn({ repo: repo, rejected: 'unknown bucket' });
		return c.notFound();
	}

	const path = c.req.path.substring(`/${repo}/`.length);
	if (!path) {
		console.warn({ path: path, rejected: 'empty path' });
		return c.text('Bad Request', 400);
	}

	if (isValidatePathsEnabled(c.env) && !isPotentialMavenObjectPath(path)) {
		console.warn({ path: path, rejected: 'invalid path' });
		return c.notFound();
	}

	const buffer = await c.req.arrayBuffer();
	const uploadedMd5 = crypto.createHash('md5').update(new Uint8Array(buffer)).digest('hex');

	const isMutable = isMutablePath(path);

	if (!isMutable && !isOverwritesEnabled(c.env)) {
		const existing = await bucket.head(path);
		if (existing) {
			const existingEtag = existing.httpEtag.replace(/"/g, '');
			if (existingEtag === uploadedMd5) {
				console.info({ path: path, rejected: 'identical upload, silently ignored' });
				return c.text('Created', 201); // Silently accept identical uploads
			}
			console.warn({ path: path, rejected: 'conflicting upload, rejected' });
			return c.text('Conflict: Artifacts are immutable and overwrites are disabled.', 409);
		}
	}

	const isChecksumFile = path.endsWith('.md5') || path.endsWith('.sha1') || path.endsWith('.sha256') || path.endsWith('.sha512');

	// If autogeneration is enabled, we already generated the checksums when the target file was uploaded.
	// Just silently ignore any explicit checksum uploads from the client.
	if (isChecksumFile && c.env.CHECKSUM_AUTOGENERATION === 'true') {
		console.info({ path: path, rejected: 'autogenerated checksum, silently ignored' });
		return c.text('Created', 201);
	}

	// Checksum validation (only if autogeneration is false)
	if (isChecksumFile && c.env.CHECKSUM_VALIDATION === 'true') {
		const targetPath = path.substring(0, path.lastIndexOf('.'));
		const targetObject = await bucket.get(targetPath);
		// We only validate if the target file actually exists. If it doesn't,
		// it means they uploaded the checksum first, which we'll just accept.
		if (targetObject && 'body' in targetObject && targetObject.body) {
			const targetBuffer = await targetObject.arrayBuffer();
			const uploadedHashText = new TextDecoder().decode(buffer);

			let algo = 'md5';
			if (path.endsWith('.sha1')) algo = 'sha1';
			if (path.endsWith('.sha256')) algo = 'sha256';
			if (path.endsWith('.sha512')) algo = 'sha512';

			const computedHash = crypto.createHash(algo).update(new Uint8Array(targetBuffer)).digest('hex');
			const uploadedHash = uploadedHashText.split(/\s+/)[0].trim().toLowerCase();

			if (computedHash !== uploadedHash) {
				console.warn({ path: path, rejected: 'checksum mismatch, rejected' });
				return c.text(`Checksum mismatch. Expected ${computedHash}, got ${uploadedHash}`, 400);
			}

			await bucket.put(path, uploadedHashText, {
				httpMetadata: { contentType: 'text/plain' },
			});
			console.info({ path: path, accepted: 'checksum validated, accepted' });
			return c.text('Created', 201);
		}
	}

	await bucket.put(path, buffer, {
		httpMetadata: {
			contentType: c.req.header('content-type') || 'application/octet-stream',
		},
	});

	// Checksum autogeneration
	if (!isChecksumFile && c.env.CHECKSUM_AUTOGENERATION === 'true') {
		const arr = new Uint8Array(buffer);
		const md5 = uploadedMd5;
		const sha1 = crypto.createHash('sha1').update(arr).digest('hex');
		const sha256 = crypto.createHash('sha256').update(arr).digest('hex');
		const sha512 = crypto.createHash('sha512').update(arr).digest('hex');

		await Promise.all([
			bucket.put(`${path}.md5`, md5, { httpMetadata: { contentType: 'text/plain' } }),
			bucket.put(`${path}.sha1`, sha1, { httpMetadata: { contentType: 'text/plain' } }),
			bucket.put(`${path}.sha256`, sha256, { httpMetadata: { contentType: 'text/plain' } }),
			bucket.put(`${path}.sha512`, sha512, { httpMetadata: { contentType: 'text/plain' } }),
		]);
	}

	// Trigger metadata debounce
	if (!isChecksumFile && !path.includes('maven-metadata.xml')) {
		const parts = path.split('/');
		if (parts.length >= 3) {
			const root = parts.slice(0, parts.length - 2).join('/') + '/';
			const id = c.env.METADATA_DEBOUNCER.idFromName(`${repo}:${root}`);
			const stub = c.env.METADATA_DEBOUNCER.get(id);

			const url = new URL('http://do/trigger');
			url.searchParams.set('repo', repo);
			url.searchParams.set('root', root);

			c.executionCtx.waitUntil(stub.fetch(new Request(url.toString())));
		}
	}

	console.info({ path: path, accepted: 'upload accepted' });
	return c.text('Created', 201);
});
