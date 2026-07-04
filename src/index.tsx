import { Hono } from 'hono';
import { basicAuth } from './auth';
import { api } from './api';
import { ui } from './ui';

const app = new Hono<{ Bindings: Env }>({ strict: false });

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
