/**
 * Context Compaction Service.
 *
 * When pruning alone can't keep context usage under budget, this service
 * summarizes old conversation turns into a compact summary using an LLM.
 * The summary replaces the old messages, preserving the most recent turns
 * intact so the agent retains full context for its current task.
 *
 * Uses the same summarization model as web_fetch (Kimi K2.5) for
 * code-aware, high-quality conversation summaries.
 */

import { generateText } from 'ai';

import { SUMMARIZATION_AI_MODEL } from '@shared/constants';

import { estimateMessagesTokens } from './context-pruner';
import { createAdapter } from './workers-ai';

import type { ModelMessage } from 'ai';

// =============================================================================
// Constants
// =============================================================================

/** Maximum characters of serialized old messages sent to the summarization model. */
const MAX_SERIALIZATION_LENGTH = 100_000;

/** Maximum output tokens for the compaction summary. */
const MAX_SUMMARY_TOKENS = 4096;

const COMPACTION_SYSTEM_PROMPT = `You are summarizing a conversation between a user and an AI coding assistant working in a web-based IDE.
Produce a concise summary that preserves:
1. Files that were read, created, modified, or deleted (with paths)
2. Key decisions made and their rationale
3. The current state of the task (what's done, what remains)
4. Any errors encountered and how they were resolved
5. Important context about the project structure

Be factual and concise. Use bullet points. Do not include code snippets unless they are essential context.`;

// =============================================================================
// Public API
// =============================================================================

/**
 * Compact old messages into a summary, preserving recent turns.
 *
 * @param messages - The full working message array
 * @param protectRecentTurns - Number of recent user turns to keep intact
 * @param signal - Optional abort signal
 * @returns The compacted message array and token savings, or undefined on failure
 */
export async function compactMessages(
	messages: ModelMessage[],
	protectRecentTurns: number,
	signal?: AbortSignal,
): Promise<{ messages: ModelMessage[]; compactedTokens: number } | undefined> {
	// Find the partition point: protect the last N user turns
	const partitionIndex = findPartitionIndex(messages, protectRecentTurns);
	if (partitionIndex <= 0) return undefined; // Nothing old enough to compact

	const oldMessages = messages.slice(0, partitionIndex);
	const recentMessages = messages.slice(partitionIndex);

	const oldTokens = estimateMessagesTokens(oldMessages);
	if (oldTokens < 5000) return undefined; // Not worth compacting small histories

	// Serialize old messages into a human-readable format for the summarizer
	const serialized = serializeMessages(oldMessages);
	const truncatedSerialized =
		serialized.length > MAX_SERIALIZATION_LENGTH
			? serialized.slice(0, MAX_SERIALIZATION_LENGTH) + '\n... (older content truncated)'
			: serialized;

	// Summarize via LLM
	const model = createAdapter(SUMMARIZATION_AI_MODEL);
	const { text: summary } = await generateText({
		model,
		system: COMPACTION_SYSTEM_PROMPT,
		messages: [{ role: 'user' as const, content: truncatedSerialized }],
		maxOutputTokens: MAX_SUMMARY_TOKENS,
		abortSignal: signal,
	});

	if (!summary.trim()) return undefined;

	// Build the replacement message
	const compactionMessage: ModelMessage = {
		role: 'user',
		content: `[Conversation Summary — earlier messages have been compacted to save context]\n\n${summary.trim()}`,
	};

	const compactedMessages = [compactionMessage, ...recentMessages];
	const newTokens = estimateMessagesTokens(compactedMessages);
	const originalTokens = estimateMessagesTokens(messages);
	const compactedTokens = originalTokens - newTokens;

	// Only return if we actually saved meaningful tokens
	if (compactedTokens < 2000) return undefined;

	return { messages: compactedMessages, compactedTokens };
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Find the index that separates "old" messages from "recent" messages.
 * Walks backwards, counting user turns. Returns the index of the Nth
 * user turn from the end.
 */
function findPartitionIndex(messages: ModelMessage[], protectRecentTurns: number): number {
	let userTurns = 0;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === 'user') {
			userTurns++;
			if (userTurns >= protectRecentTurns) {
				return index;
			}
		}
	}
	return 0; // Not enough turns to partition
}

/**
 * Serialize a ModelMessage array into human-readable text for the summarizer.
 */
function serializeMessages(messages: ModelMessage[]): string {
	const lines: string[] = [];

	for (const message of messages) {
		switch (message.role) {
			case 'user': {
				const text = typeof message.content === 'string' ? message.content : '';
				lines.push(`User: ${text}`);

				break;
			}
			case 'assistant': {
				if (typeof message.content === 'string') {
					lines.push(`Assistant: ${message.content}`);
				} else if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part.type === 'text') {
							lines.push(`Assistant: ${part.text}`);
						} else if (part.type === 'tool-call') {
							const inputSummary =
								part.input && typeof part.input === 'object'
									? JSON.stringify(part.input).slice(0, 200)
									: String(part.input ?? '').slice(0, 200);
							lines.push(`[Tool call: ${part.toolName} ${inputSummary}]`);
						}
					}
				}

				break;
			}
			case 'tool': {
				if (Array.isArray(message.content)) {
					for (const part of message.content) {
						if (part.type === 'tool-result') {
							const rawOutput: unknown = part.output;
							const output =
								typeof rawOutput === 'string'
									? rawOutput.slice(0, 300)
									: typeof rawOutput === 'object' && rawOutput !== undefined && rawOutput !== null && 'value' in rawOutput
										? String((rawOutput as Record<string, unknown>).value).slice(0, 300) // eslint-disable-line @typescript-eslint/consistent-type-assertions -- narrowed above
										: '[result]';
							lines.push(`[Tool result (${part.toolName}): ${output}]`);
						}
					}
				}

				break;
			}
			// No default
		}
	}

	return lines.join('\n');
}
