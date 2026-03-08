// Worker entry point - Hono API
import { Hono } from 'hono';

const app = new Hono();

// Simple greeting endpoint
app.get('/api/hello', (c) => {
	return c.json({
		message: 'Hello from Cloudflare Workers!',
		timestamp: new Date().toISOString(),
	});
});

// Catch-all
app.all('*', (c) => {
	return c.json({ error: 'Not found' }, 404);
});

export default app;
