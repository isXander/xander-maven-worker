import { Hono } from 'hono';
import { html } from 'hono/html';
import { basicAuth } from './auth';
import { api } from './api';
import { ui } from './ui'; // will resolve to ui.tsx natively

const app = new Hono<{ Bindings: Env }>({ strict: false });

export const Layout = ({ versionId, children }: { versionId: string; children?: any }) => (
	<html lang="en">
		<head>
			<meta charset="UTF-8" />
			<meta name="viewport" content="width=device-width, initial-scale=1.0" />
			<title>Maven Repository Browser</title>
			<script src="https://unpkg.com/htmx.org@1.9.11"></script>
			<link rel="stylesheet" href={`/style.css?v=${versionId}`} />
		</head>
		<body hx-boost="true" hx-target="#content">
			<div class="container">
				<h1>Maven Repository</h1>
				<div id="content" style="min-height: 200px;">
					{children}
				</div>
			</div>
		</body>
	</html>
);

app.get('/', (c) => c.redirect('/web'));

// Enforce auth on API PUT requests
app.use('*', basicAuth);

// UI HTML fragments
app.route('/web', ui);

// API routes (GET/PUT artifacts)
app.route('/', api);

export { MetadataDebouncer } from './debounce';

export default {
	fetch: app.fetch,
};
