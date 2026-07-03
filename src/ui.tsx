import { Hono } from 'hono';
import { getBucket, getRepositories, MUTABLE_CACHE_CONTROL } from './utils';
import { html } from 'hono/html';
import { Layout } from './index';
import type { Context } from 'hono';

function renderContent(c: Context<{ Bindings: Env }>, content: any) {
	if (c.req.header('hx-request') === 'true' || c.req.header('HX-Request') === 'true') {
		return c.html(content);
	}
	return c.html(html`<!DOCTYPE html>${<Layout versionId={c.env.CF_VERSION_METADATA.id}>{content}</Layout>}`);
}

const ui = new Hono<{ Bindings: Env }>({ strict: false });

// This endpoint returns HTML fragments for HTMX
ui.get('/', async (c) => {
	// List all repositories (R2 bindings)
	const bindings = getRepositories(c.env).sort();

	c.header('Cache-Control', MUTABLE_CACHE_CONTROL);

	return renderContent(c,
		<ul>
			{bindings.map((repo) => (
				<li>
					<a href={`/web/${repo}/`}>
						📁 {repo}/
					</a>
				</li>
			))}
		</ul>,
	);
});

ui.get('/:repo/*', async (c) => {
	const repo = c.req.param('repo');
	let path = c.req.path.substring(`/web/${repo}`.length);
	if (path.startsWith('/')) path = path.substring(1);
	if (path.length > 0 && !path.endsWith('/')) path += '/';

	c.header('Cache-Control', MUTABLE_CACHE_CONTROL);

	const bucket = getBucket(c.env, repo);
	if (!bucket) {
		return renderContent(c, <div class="error">Repository not found</div>);
	}

	let cursor: string | undefined;
	let truncated = false;
	const allPrefixes: string[] = [];
	const allObjects: R2Object[] = [];

	do {
		const listed = await bucket.list({
			prefix: path,
			delimiter: '/',
			cursor,
		});

		allPrefixes.push(...listed.delimitedPrefixes);
		allObjects.push(...listed.objects);

		truncated = listed.truncated;
		cursor = listed.truncated ? listed.cursor : undefined;
	} while (truncated);

	const parts = path.split('/').filter(Boolean);

	let currentPath = '';
	const breadcrumbs = parts.map((part) => {
		currentPath += part + '/';
		return (
			<>
				{' '}
				<a href={`/web/${repo}/${currentPath}`}>
					{part}
				</a>{' '}
				/
			</>
		);
	});

	const upPath = parts.slice(0, -1).join('/');
	const upHref = upPath ? `/web/${repo}/${upPath}/` : `/web/${repo}/`;

	const folders = allPrefixes.sort();
	const files = allObjects.sort((a, b) => a.key.localeCompare(b.key));

	return renderContent(c,
		<>
			<div class="breadcrumbs">
				<a href="/web">
					root
				</a>{' '}
				/{' '}
				<a href={`/web/${repo}/`}>
					{repo}
				</a>{' '}
				{breadcrumbs.length > 0 ? <>/ {breadcrumbs}</> : ''}
			</div>

			<ul>
				{path.length > 0 && (
					<li>
						<a href={upHref}>
							..
						</a>
					</li>
				)}

				{folders.map((folder) => {
					const folderName = folder.substring(path.length);
					return (
						<li>
							<a href={`/web/${repo}/${folder}`}>
								📁 {folderName}
							</a>
						</li>
					);
				})}

				{files.map((file) => {
					if (file.key === path) return null; // skip the folder itself if it's an object
					const fileName = file.key.substring(path.length);
					const size = (file.size / 1024).toFixed(2) + ' KB';
					const dateObj = new Date(file.uploaded);
					const date = `${dateObj.getFullYear()}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${String(dateObj.getDate()).padStart(2, '0')}`;

					return (
						<li>
							<a href={`/${repo}/${file.key}`} target="_blank">
								📄 {fileName}
							</a>
							<span class="meta">
								{size} &bull; {date}
							</span>
						</li>
					);
				})}
			</ul>
		</>,
	);
});

export { ui };
