import XMLBuilder from 'fast-xml-builder';
import crypto from 'node:crypto';
import { getBucket } from './utils';
import { DurableObject } from 'cloudflare:workers';

export class MetadataDebouncer extends DurableObject {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
	}

	async fetch(request: Request) {
		const url = new URL(request.url);
		if (url.pathname === '/trigger') {
			const repo = url.searchParams.get('repo');
			const root = url.searchParams.get('root');

			if (!repo || !root) {
				return new Response('Bad Request', { status: 400 });
			}

			// Store the repo and root in state so the alarm knows what to process
			await this.ctx.storage.put('config', { repo, root });

			// Set alarm for 5 seconds from now
			await this.ctx.storage.setAlarm(Date.now() + 5000);
			return new Response('OK');
		}
		return new Response('Not found', { status: 404 });
	}

	async alarm() {
		const config = await this.ctx.storage.get<{ repo: string; root: string }>('config');
		if (!config) return;

		const { repo, root } = config;
		const bucket = getBucket(this.env, repo);
		if (!bucket) return;

		console.log(`Regenerating metadata for ${repo} at ${root}`);

		const artifacts = new Set<string>();
		let cursor: string | undefined;
		let truncated = false;
		let groupId = '';
		let artifactId = '';

		do {
			const list = await bucket.list({ prefix: root, cursor });
			truncated = list.truncated;
			cursor = list.truncated ? list.cursor : undefined;

			for (const obj of list.objects) {
				if (!obj.key.endsWith('.pom')) continue;
				// obj.key is root + version + / + filename.pom
				const relative = obj.key.substring(root.length);
				const parts = relative.split('/');
				if (parts.length >= 2) {
					artifacts.add(parts[0]);

					if (!groupId) {
						// Reconstruct from root
						const rootParts = root.split('/').filter(Boolean);
						if (rootParts.length >= 2) {
							artifactId = rootParts[rootParts.length - 1];
							groupId = rootParts.slice(0, rootParts.length - 1).join('.');
						}
					}
				}
			}
		} while (truncated);

		if (artifacts.size === 0) return;

		const versions = Array.from(artifacts).sort((a, b) => {
			const pa = a.split(/[.-]/).map(Number);
			const pb = b.split(/[.-]/).map(Number);
			for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
				const na = isNaN(pa[i]) ? -1 : pa[i];
				const nb = isNaN(pb[i]) ? -1 : pb[i];
				if (na !== nb) return na - nb;
			}
			return a.localeCompare(b);
		});

		const latest = versions[versions.length - 1];
		const releases = versions.filter((v) => !v.toUpperCase().includes('SNAPSHOT'));
		const release = releases.length > 0 ? releases[releases.length - 1] : latest;

		const now = new Date();
		const lastUpdated = now
			.toISOString()
			.replace(/[-:T.]/g, '')
			.substring(0, 14);

		const builder = new XMLBuilder({
			format: true,
			ignoreAttributes: false,
		});

		const xmlObj = {
			'?xml': { '@_version': '1.0', '@_encoding': 'UTF-8' },
			metadata: {
				groupId,
				artifactId,
				versioning: {
					latest,
					release,
					versions: {
						version: versions,
					},
					lastUpdated,
				},
			},
		};

		const xml = builder.build(xmlObj);
		const buffer = new TextEncoder().encode(xml);

		await bucket.put(`${root}maven-metadata.xml`, buffer, {
			httpMetadata: { contentType: 'application/xml' },
		});

		// Autogenerate checksums if enabled
		if (this.env.CHECKSUM_AUTOGENERATION === 'true') {
			const md5 = crypto.createHash('md5').update(buffer).digest('hex');
			const sha1 = crypto.createHash('sha1').update(buffer).digest('hex');
			const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
			const sha512 = crypto.createHash('sha512').update(buffer).digest('hex');

			await Promise.all([
				bucket.put(`${root}maven-metadata.xml.md5`, md5, { httpMetadata: { contentType: 'text/plain' } }),
				bucket.put(`${root}maven-metadata.xml.sha1`, sha1, { httpMetadata: { contentType: 'text/plain' } }),
				bucket.put(`${root}maven-metadata.xml.sha256`, sha256, { httpMetadata: { contentType: 'text/plain' } }),
				bucket.put(`${root}maven-metadata.xml.sha512`, sha512, { httpMetadata: { contentType: 'text/plain' } }),
			]);
		}

		console.log(`Finished regenerating metadata for ${repo} at ${root}`);
	}
}
