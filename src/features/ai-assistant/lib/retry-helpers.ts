/**
 * Helper functions for AI retry logic.
 * Extracted for testability.
 *
 * Works with UIMessage (TanStack AI) which has `parts: MessagePart[]`.
 * Text content is in TextPart: { type: 'text', content: string }.
 */

import type { UIMessage } from '@shared/types';

/**
 * Extract the text content from a UIMessage.
 */
export function extractMessageText(message: UIMessage): string {
	return message.parts
		.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
		.map((part) => part.content)
		.join('\n');
}

/**
 * Find the last user message in history.
 */
export function findLastUserMessage(history: UIMessage[]): UIMessage | undefined {
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
export function getRemoveAfterIndex(history: UIMessage[]): number {
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
export function prepareRetry(history: UIMessage[]): { promptText: string; removeAfterIndex: number } | undefined {
	const lastUserMessage = findLastUserMessage(history);
	if (!lastUserMessage) {
		return undefined;
	}

	const promptText = extractMessageText(lastUserMessage);
	const removeAfterIndex = getRemoveAfterIndex(history);

	return { promptText, removeAfterIndex };
}
