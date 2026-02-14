/**
 * Tool: web_fetch
 * Fetch and read web page content.
 */

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Fetch and read web page content from a URL. Prefers markdown when the server supports it, otherwise extracts readable content from HTML. Useful for looking up documentation or online resources.

Usage:
- Only http:// and https:// URLs are supported.
- Returns markdown when available, otherwise extracts headings, paragraphs, lists, and code blocks from HTML.
- Content is truncated to max_length characters (default: 8000).
- Requests have a 10-second timeout.`;

export const definition: ToolDefinition = {
	name: 'web_fetch',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			url: { type: 'string', description: 'The URL to fetch (must be http:// or https://)' },
			max_length: { type: 'string', description: 'Maximum characters to return (default: 8000)' },
		},
		required: ['url'],
	},
};

// =============================================================================
// Content extraction helpers
// =============================================================================

/**
 * Check whether the response body looks like markdown rather than HTML.
 */
function isMarkdownContent(contentType: string, body: string): boolean {
	if (contentType.includes('text/markdown') || contentType.includes('text/x-markdown')) {
		return true;
	}
	// Heuristic: if the body doesn't start with < it's probably not HTML
	const trimmed = body.trimStart();
	return !trimmed.startsWith('<') && !trimmed.startsWith('<!');
}

/**
 * Extract the page title from an HTML string.
 */
function extractTitle(html: string): string {
	const match = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
	return match ? match[1].replaceAll(/\s+/g, ' ').trim() : '';
}

/**
 * Convert an HTML string into a condensed plain-text / markdown-ish
 * representation that keeps the most useful information for an LLM:
 * title, headings, paragraphs, list items, and code blocks.
 */
function extractReadableContent(html: string): string {
	// Strip noise
	let content = html;
	content = content.replaceAll(/<script[\s\S]*?<\/script>/gi, '');
	content = content.replaceAll(/<style[\s\S]*?<\/style>/gi, '');
	content = content.replaceAll(/<nav[\s\S]*?<\/nav>/gi, '');
	content = content.replaceAll(/<footer[\s\S]*?<\/footer>/gi, '');
	content = content.replaceAll(/<header[\s\S]*?<\/header>/gi, '');
	content = content.replaceAll(/<!--[\s\S]*?-->/g, '');

	const sections: string[] = [];

	// Title
	const title = extractTitle(html);
	if (title) {
		sections.push(`# ${title}\n`);
	}

	// Headings → markdown-style
	for (const headingMatch of content.matchAll(/<(h[1-6])[^>]*>([\s\S]*?)<\/\1>/gi)) {
		const level = Number(headingMatch[1].charAt(1));
		const text = stripTags(headingMatch[2]).trim();
		if (text) {
			sections.push(`${'#'.repeat(level)} ${text}\n`);
		}
	}

	// Paragraphs
	for (const paragraphMatch of content.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/gi)) {
		const text = stripTags(paragraphMatch[1]).trim();
		if (text.length > 20) {
			sections.push(text + '\n');
		}
	}

	// List items
	for (const listItemMatch of content.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) {
		const text = stripTags(listItemMatch[1]).trim();
		if (text) {
			sections.push(`- ${text}`);
		}
	}

	// Code blocks (pre)
	for (const codeMatch of content.matchAll(/<pre[^>]*>([\s\S]*?)<\/pre>/gi)) {
		const code = stripTags(codeMatch[1]).trim();
		if (code) {
			sections.push(`\`\`\`\n${code}\n\`\`\`\n`);
		}
	}

	// Deduplicate (headings may appear inside paragraphs too)
	const seen = new Set<string>();
	const unique = sections.filter((section) => {
		const key = section.trim().toLowerCase();
		if (seen.has(key)) return false;
		seen.add(key);
		return true;
	});

	return unique
		.join('\n')
		.replaceAll(/\n{3,}/g, '\n\n')
		.trim();
}

/**
 * Strip all HTML tags from a string and collapse whitespace.
 */
function stripTags(html: string): string {
	let result = html;
	result = result.replaceAll(/<br\s*\/?>/gi, '\n');
	result = result.replaceAll(/<[^>]+>/g, ' ');
	result = result.replaceAll('&amp;', '&');
	result = result.replaceAll('&lt;', '<');
	result = result.replaceAll('&gt;', '>');
	result = result.replaceAll('&quot;', '"');
	result = result.replaceAll('&#39;', String.raw`'`);
	result = result.replaceAll('&nbsp;', ' ');
	result = result.replaceAll(/\s+/g, ' ');
	return result.trim();
}

// =============================================================================
// Execute
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	_context: ToolExecutorContext,
): Promise<string | object> {
	const fetchUrl = input.url;
	const maxLength = input.max_length ? Number.parseInt(input.max_length, 10) : 8000;

	await sendEvent('status', { message: `Fetching ${fetchUrl}...` });

	try {
		const parsedUrl = new URL(fetchUrl);
		if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
			return { error: 'Only http:// and https:// URLs are supported' };
		}

		const response = await fetch(fetchUrl, {
			headers: {
				'User-Agent': 'WorkerIDE-Agent/1.0',
				Accept: 'text/markdown, text/html',
			},
			signal: AbortSignal.timeout(10_000),
		});

		if (!response.ok) {
			return { error: `HTTP ${response.status}: ${response.statusText}` };
		}

		const contentType = response.headers.get('content-type') ?? '';
		const raw = await response.text();

		let text = isMarkdownContent(contentType, raw) ? raw.trim() : extractReadableContent(raw);

		if (text.length > maxLength) {
			text = text.slice(0, maxLength) + '\n... (truncated)';
		}

		return { url: fetchUrl, content: text, length: text.length };
	} catch (error) {
		return { error: `Failed to fetch ${fetchUrl}: ${String(error)}` };
	}
}
