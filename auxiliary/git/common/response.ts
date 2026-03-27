/**
 * Lightweight response helpers to keep handlers concise and consistent.
 * Prefer these over ad-hoc new Response(...) in endpoint code.
 */

export function text(body: string, status = 200, headers: HeadersInit = {}) {
	const h = new Headers(headers);
	if (!h.has('Content-Type')) h.set('Content-Type', 'text/plain; charset=utf-8');
	return new Response(body, { status, headers: h });
}
