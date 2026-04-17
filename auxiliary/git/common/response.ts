export function text(body: string, status = 200, headers: HeadersInit = {}) {
	const h = new Headers(headers);
	if (!h.has('Content-Type')) h.set('Content-Type', 'text/plain; charset=utf-8');
	return new Response(body, { status, headers: h });
}
