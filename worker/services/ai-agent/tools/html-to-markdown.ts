import { env } from 'cloudflare:workers';

/**
 * Convert raw HTML to markdown using Cloudflare Workers AI `toMarkdown()`.
 * Returns `undefined` on conversion failure.
 */
export async function convertHtmlToMarkdown(html: string): Promise<string | undefined> {
	const blob = new Blob([html], { type: 'text/html' });
	const results = await env.AI.toMarkdown([{ name: 'page.html', blob }]);
	const result = results[0];
	if (!result || result.format === 'error') {
		return undefined;
	}
	return result.data;
}
