/**
 * Standalone HTML error page for server-side error responses.
 *
 * Returns a self-contained HTML page (no external CSS/JS) styled to match the
 * app's dark theme. Used for 404s on the landing domain, invalid preview
 * projects, and other server-side errors that can't be handled by the SPA.
 */

interface ErrorPageOptions {
	/** Page title (shown in browser tab). */
	title?: string;
	/** Main heading displayed in the card. */
	heading: string;
	/** Descriptive paragraph below the heading. */
	message: string;
	/** URL for the "Back to Home" button. If omitted, no button is shown. */
	homeUrl?: string;
	/** HTTP status code for the response. */
	status: number;
}

/**
 * Build a Response containing a styled HTML error page.
 */
function escapeHtml(unsafe: string): string {
	return unsafe
		.replaceAll('&', '&amp;')
		.replaceAll('<', '&lt;')
		.replaceAll('>', '&gt;')
		.replaceAll('"', '&quot;')
		.replaceAll("'", '&#039;');
}

export function errorPage({ title, heading, message, homeUrl, status }: ErrorPageOptions): Response {
	const pageTitle = escapeHtml(title ?? 'Worker IDE');

	// SVG hexagon icon matching the app branding (Lucide Hexagon)
	const hexagonSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/></svg>`;

	const homeButton = homeUrl
		? `<a href="${escapeHtml(homeUrl)}" style="
				display:inline-flex;align-items:center;gap:8px;
				padding:10px 20px;border-radius:6px;
				background:#f14602;color:#fff;
				font-size:14px;font-weight:500;
				text-decoration:none;transition:background 0.15s;
			" onmouseover="this.style.background='#ff6d33'" onmouseout="this.style.background='#f14602'">
				<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 9 9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
				Back to Home
			</a>`
		: '';

	const html = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<title>${pageTitle}</title>
	<link rel="icon" type="image/svg+xml" href="/favicon.svg">
	<link rel="preconnect" href="https://fonts.googleapis.com">
	<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
	<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;600&display=swap" rel="stylesheet">
	<style>
		*{margin:0;padding:0;box-sizing:border-box}
		body{
			font-family:'Space Grotesk',sans-serif;
			background:#121212;color:#f0e3de;
			display:flex;align-items:center;justify-content:center;
			min-height:100vh;padding:16px;
		}
		.card{
			max-width:480px;width:100%;
			border:1px solid rgba(240,227,222,0.125);
			background:#191817;border-radius:12px;
			padding:40px;box-shadow:0 4px 24px rgba(0,0,0,0.3);
		}
		.icon{color:#f14602;margin-bottom:16px}
		h1{font-size:20px;font-weight:600;margin-bottom:8px;color:#f0e3de}
		p{font-size:14px;color:rgba(255,253,251,0.56);line-height:1.6;margin-bottom:32px}
	</style>
</head>
<body>
	<div class="card">
		<div class="icon">${hexagonSvg}</div>
		<h1>${escapeHtml(heading)}</h1>
		<p>${escapeHtml(message)}</p>
		${homeButton}
	</div>
</body>
</html>`;

	return new Response(html, {
		status,
		headers: { 'Content-Type': 'text/html;charset=UTF-8' },
	});
}
