/**
 * AI-powered session title generation.
 *
 * Only requires the user's first message — no dependency on the assistant
 * response. This allows title generation to fire immediately when a session
 * starts, completely independent of the agent stream lifecycle.
 */

import { chat, maxIterations } from '@tanstack/ai';
import { z } from 'zod';

import { createAdapter } from './workers-ai';

/** Lightweight non-thinking model for structured title generation. */
const TITLE_MODEL = '@cf/meta/llama-3.1-8b-instruct';

const MAX_TITLE_LENGTH = 100;
const FALLBACK_TRUNCATION_LENGTH = 50;

const SYSTEM_PROMPT = 'Generate a short title (under 10 words) that summarizes the intent of this user message. Reply with just the title.';

const titleSchema = z.object({
	title: z.string().describe('A concise title under 10 words summarizing the user intent'),
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
		const adapter = createAdapter(TITLE_MODEL);

		const result = await chat({
			adapter,
			messages: [{ role: 'user', content: userMessage.slice(0, 500) }],
			systemPrompts: [SYSTEM_PROMPT],
			maxTokens: 500,
			agentLoopStrategy: maxIterations(1),
			outputSchema: titleSchema,
			stream: false,
		});

		const title = result.title.trim();
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
