/**
 * AI-powered session title generation.
 *
 * Generates concise (<10 word) titles for AI agent sessions using Workers AI.
 * Retries up to {@link MAX_RETRIES} times with exponential backoff when the
 * AI endpoint is temporarily unavailable. Falls back to truncating the first
 * user message if all attempts fail.
 */

import { env } from 'cloudflare:workers';

/** Timeout for a single Workers AI call (ms). */
const TITLE_GENERATION_TIMEOUT_MS = 5000;

/** Maximum number of retry attempts before falling back. */
const MAX_RETRIES = 3;

/** Initial backoff delay between retries (ms). Doubles on each attempt. */
const RETRY_INITIAL_DELAY_MS = 1000;

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TRUNCATION_LENGTH = 50;

/** Workers AI model used for title generation. Typed to satisfy `env.AI.run()` overloads. */
const TITLE_MODEL: Parameters<typeof env.AI.run>[0] = '@cf/meta/llama-3.2-3b-instruct';

/**
 * Generate a short title for an AI agent session.
 *
 * Uses Cloudflare Workers AI to summarize the conversation opener into
 * a concise title under 10 words. Retries with exponential backoff on
 * transient failures. Falls back to truncating the first user message
 * if all attempts fail or time out.
 */
export async function generateSessionTitle(firstUserMessage: string, firstAssistantResponse: string): Promise<string> {
	const fallback = deriveFallbackTitle(firstUserMessage);

	const prompt = [
		`User message: ${firstUserMessage.slice(0, 500)}`,
		'',
		`Assistant response (excerpt): ${firstAssistantResponse.slice(0, 500)}`,
	].join('\n');

	for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
		try {
			const result = await Promise.race([
				env.AI.run(TITLE_MODEL, {
					messages: [
						{
							role: 'system',
							content:
								'Generate a short title (under 10 words) that summarizes this conversation. Output ONLY the title text, nothing else. No quotes, no punctuation at the end, no prefixes like "Title:".',
						},
						{ role: 'user', content: prompt },
					],
					max_tokens: 30,
				}),
				new Promise<never>((_resolve, reject) => {
					setTimeout(() => reject(new Error('Title generation timed out')), TITLE_GENERATION_TIMEOUT_MS);
				}),
			]);

			const rawTitle = typeof result === 'object' && result !== undefined && 'response' in result ? String(result.response) : '';

			const cleaned = cleanTitle(rawTitle);
			if (cleaned.length > 0) {
				return cleaned;
			}

			// Empty response — not worth retrying, just use fallback
			break;
		} catch (error) {
			// On the last attempt, give up and use fallback
			if (attempt >= MAX_RETRIES) {
				break;
			}

			// Only retry on transient/network errors, not on bad input
			if (!isRetryableError(error)) {
				break;
			}

			// Exponential backoff: 1s, 2s, 4s
			const delay = RETRY_INITIAL_DELAY_MS * 2 ** attempt;
			await new Promise<void>((resolve) => setTimeout(resolve, delay));
		}
	}

	return fallback;
}

/**
 * Determine if a title generation error is worth retrying.
 *
 * Retries on: timeouts, network errors, 5xx server errors, rate limits.
 * Does NOT retry on: invalid input, auth errors, unknown non-transient errors.
 */
function isRetryableError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;

	const message = error.message.toLowerCase();

	// Our own timeout wrapper
	if (message.includes('timed out')) return true;

	// Network-level failures
	if (message.includes('fetch failed') || message.includes('network')) return true;

	// Workers AI transient errors (5xx, overloaded, rate limited)
	if (/5\d{2}/.test(message)) return true;
	if (message.includes('overloaded') || message.includes('unavailable')) return true;
	if (message.includes('rate') && message.includes('limit')) return true;
	if (message.includes('too many requests') || message.includes('429')) return true;

	return false;
}

/**
 * Clean up a raw AI-generated title:
 * - Strip surrounding quotes
 * - Remove "Title:" prefixes
 * - Trim whitespace
 * - Enforce max length
 */
function cleanTitle(raw: string): string {
	let cleaned = raw.trim();

	// Remove common AI prefixes
	for (const prefix of ['Title:', 'title:', 'TITLE:']) {
		if (cleaned.startsWith(prefix)) {
			cleaned = cleaned.slice(prefix.length).trim();
		}
	}

	// Remove surrounding quotes
	if ((cleaned.startsWith('"') && cleaned.endsWith('"')) || (cleaned.startsWith("'") && cleaned.endsWith("'"))) {
		cleaned = cleaned.slice(1, -1).trim();
	}

	// Remove trailing period
	if (cleaned.endsWith('.')) {
		cleaned = cleaned.slice(0, -1).trim();
	}

	// Enforce max length
	if (cleaned.length > MAX_TITLE_LENGTH) {
		cleaned = cleaned.slice(0, MAX_TITLE_LENGTH).trim();
	}

	return cleaned;
}

/**
 * Derive a fallback title from the first user message (truncated to 50 chars).
 */
export function deriveFallbackTitle(userMessageText: string): string {
	const trimmed = userMessageText.trim();
	if (trimmed.length === 0) return 'New chat';
	return trimmed.length > FALLBACK_TRUNCATION_LENGTH ? trimmed.slice(0, FALLBACK_TRUNCATION_LENGTH) + '...' : trimmed;
}
