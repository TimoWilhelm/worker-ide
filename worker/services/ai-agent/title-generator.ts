/**
 * AI-powered session title generation.
 *
 * Only requires the user's first message — no dependency on the assistant
 * response. This allows title generation to fire immediately when a session
 * starts, completely independent of the agent stream lifecycle.
 */

import { generateText, jsonSchema, Output } from 'ai';

import { createAdapter } from './workers-ai';

/** Lightweight non-thinking model for structured title generation. */
const TITLE_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TRUNCATION_LENGTH = 50;

const SYSTEM_PROMPT =
	'You are a title generator. Read the user message below and respond with a short title (under 10 words) that captures what the user wants to do. Do NOT repeat these instructions. Do NOT describe what you are doing. Just output the title text.';

const titleOutput = Output.object({
	schema: jsonSchema<{ title: string }>({
		type: 'object',
		properties: {
			title: { type: 'string', description: 'The generated title text' },
		},
		required: ['title'],
	}),
});

export interface SessionTitleResult {
	title: string;
	isAiGenerated: boolean;
}

/**
 * Generate a short title for an AI agent session.
 * Falls back to truncating the user message on failure.
 */
export async function generateSessionTitle(userMessage: string): Promise<SessionTitleResult> {
	const fallback = deriveFallbackTitle(userMessage);

	try {
		const model = createAdapter(TITLE_MODEL);

		const { output } = await generateText({
			model,
			messages: [{ role: 'user' as const, content: userMessage.slice(0, 500) }],
			system: SYSTEM_PROMPT,
			maxOutputTokens: 500,
			output: titleOutput,
		});

		const title = output?.title.trim() ?? '';
		if (title.length === 0) {
			return { title: fallback, isAiGenerated: false };
		}

		const truncated = title.length > MAX_TITLE_LENGTH ? title.slice(0, MAX_TITLE_LENGTH).trim() : title;
		return { title: truncated, isAiGenerated: true };
	} catch {
		return { title: fallback, isAiGenerated: false };
	}
}

/**
 * Derive a fallback title from the first user message (truncated to 50 chars).
 */
export function deriveFallbackTitle(userMessageText: string): string {
	const trimmed = userMessageText.trim();
	if (trimmed.length === 0) return 'New chat';
	return trimmed.length > FALLBACK_TRUNCATION_LENGTH ? trimmed.slice(0, FALLBACK_TRUNCATION_LENGTH) + '...' : trimmed;
}
