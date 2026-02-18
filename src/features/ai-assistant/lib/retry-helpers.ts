/**
 * Helper functions for AI retry logic.
 * Extracted for testability.
 */

import type { AgentMessage } from '@shared/types';

/**
 * Extract the text content from an agent message.
 */
export function extractMessageText(message: AgentMessage): string {
	return message.content
		.filter((block): block is { type: 'text'; text: string } => block.type === 'text')
		.map((block) => block.text)
		.join('\n');
}

/**
 * Find the last user message in history.
 */
export function findLastUserMessage(history: AgentMessage[]): AgentMessage | undefined {
	return [...history].toReversed().find((message) => message.role === 'user');
}

/**
 * Determine how many messages to remove before retrying.
 *
 * - If the last message is an assistant message (error during generation),
 *   remove both the assistant reply and the user message before it (2 messages).
 * - If the last message is a user message (error before assistant replied),
 *   remove just that user message (1 message).
 * - If history is empty, remove nothing (0 messages).
 *
 * Returns the index after which to remove (exclusive).
 */
export function getRemoveAfterIndex(history: AgentMessage[]): number {
	if (history.length === 0) {
		return 0;
	}

	const lastMessage = history.at(-1);

	if (lastMessage && lastMessage.role === 'assistant') {
		// Remove both the assistant reply and the user message before it
		return history.length - 2;
	}

	if (lastMessage && lastMessage.role === 'user') {
		// Remove just the dangling user message
		return history.length - 1;
	}

	return history.length;
}

/**
 * Prepare for retry by extracting the prompt text and calculating the remove index.
 * Returns undefined if there's no user message to retry.
 */
export function prepareRetry(history: AgentMessage[]): { promptText: string; removeAfterIndex: number } | undefined {
	const lastUserMessage = findLastUserMessage(history);
	if (!lastUserMessage) {
		return undefined;
	}

	const promptText = extractMessageText(lastUserMessage);
	const removeAfterIndex = getRemoveAfterIndex(history);

	return { promptText, removeAfterIndex };
}
