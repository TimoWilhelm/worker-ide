// Worker entry point - Hono API
import { Hono } from 'hono';

const app = new Hono();

// Inspect the incoming request — returns headers, geo, and connection info
app.get('/api/inspect', (c) => {
	const request = c.req.raw;
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- cf is a Workers-specific property on Request
	const cf = (request as Request & { cf?: Record<string, unknown> }).cf;

	// Collect request headers
	const headers: Record<string, string> = {};
	for (const [key, value] of request.headers.entries()) {
		headers[key] = value;
	}

	// Geolocation from Cloudflare's `cf` object (only available on CF network)
	const geo = cf
		? {
				country: cf.country ?? 'Unknown',
				city: cf.city ?? 'Unknown',
				continent: cf.continent ?? 'Unknown',
				latitude: cf.latitude ?? 'Unknown',
				longitude: cf.longitude ?? 'Unknown',
				region: cf.region ?? 'Unknown',
				regionCode: cf.regionCode ?? 'Unknown',
				postalCode: cf.postalCode ?? 'Unknown',
				timezone: cf.timezone ?? 'Unknown',
				metroCode: cf.metroCode ?? 'Unknown',
			}
		: undefined;

	// Connection and edge info
	const connection = cf
		? {
				colo: cf.colo ?? 'Unknown',
				httpProtocol: cf.httpProtocol ?? 'Unknown',
				tlsVersion: cf.tlsVersion ?? 'Unknown',
				asn: cf.asn ?? 'Unknown',
				asOrganization: cf.asOrganization ?? 'Unknown',
			}
		: undefined;

	return c.json({
		timestamp: new Date().toISOString(),
		method: request.method,
		url: request.url,
		headers,
		geo,
		connection,
		runtime: navigator.userAgent,
	});
});

// Echo endpoint — reflects back whatever you send
app.post('/api/echo', async (c) => {
	const contentType = c.req.header('content-type') ?? '';
	let body: unknown;
	try {
		body = await (contentType.includes('application/json') ? c.req.json() : c.req.text());
	} catch {
		return c.json({ error: 'Invalid JSON body' }, 400);
	}

	return c.json({
		timestamp: new Date().toISOString(),
		method: c.req.method,
		headers: Object.fromEntries(c.req.raw.headers.entries()),
		body,
	});
});

// Catch-all
app.all('*', (c) => {
	return c.json({ error: 'Not found' }, 404);
});

export default app;
