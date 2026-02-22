/**
 * Context window management for the AI agent.
 * Ported from OpenCode's SessionCompaction — provides two levels of context management:
 *
 * 1. **Pruning** — erase old tool outputs when context is getting full
 * 2. **Context budget** — check if there's enough context remaining for another iteration
 *
 * The agent loop prunes proactively at ~70% utilization, then stops when budget is exhausted.
 */

import type { ModelMessage } from '@tanstack/ai';

// =============================================================================
// Constants
// =============================================================================

/** Characters per token (rough estimate, no tokenizer dependency) */
const CHARACTERS_PER_TOKEN = 4;

/** Minimum tokens to prune before actually executing the prune */
const PRUNE_MINIMUM = 20_000;

/** Recent tool output tokens to protect from pruning */
const PRUNE_PROTECT = 40_000;

/** Placeholder text for pruned tool outputs */
const PRUNED_PLACEHOLDER = '[Old tool result content cleared]';

/**
 * Buffer reserved for model output and system prompt overhead.
 * When usable context minus this buffer is exceeded, the agent should stop.
 */
const CONTEXT_BUDGET_BUFFER = 20_000;

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count from a string using the character heuristic.
 * This avoids a tokenizer dependency — accuracy is good enough for pruning decisions.
 */
export function estimateTokens(text: string): number {
	return Math.round(text.length / CHARACTERS_PER_TOKEN);
}

/**
 * Estimate the total token count of a message array.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === 'string') {
			total += estimateTokens(message.content);
		} else if (message.content === undefined || message.content === null) {
			// No tokens for null/undefined content
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if ('text' in part && typeof part.text === 'string') {
					total += estimateTokens(part.text);
				}
			}
		}
		// Also count tool call arguments
		if (message.toolCalls) {
			for (const toolCall of message.toolCalls) {
				total += estimateTokens(toolCall.function.arguments);
			}
		}
	}
	return total;
}

// =============================================================================
// Context Overflow Detection
// =============================================================================

interface ModelLimits {
	/** Maximum context window size in tokens */
	contextWindow: number;
	/** Maximum output tokens */
	maxOutput: number;
}

/**
 * Check if there's enough context budget remaining for another iteration.
 * Returns false when the context is so full that there wouldn't be enough
 * room for a useful LLM turn (even after pruning).
 */
export function hasContextBudget(messages: ModelMessage[], limits: ModelLimits): boolean {
	if (limits.contextWindow === 0) return true;

	const currentTokens = estimateMessagesTokens(messages);
	const usable = limits.contextWindow - limits.maxOutput - CONTEXT_BUDGET_BUFFER;

	return currentTokens < usable;
}

/**
 * Get the context utilization as a fraction (0.0 to 1.0+).
 * Values above 1.0 indicate overflow.
 */
export function getContextUtilization(messages: ModelMessage[], limits: ModelLimits): number {
	if (limits.contextWindow === 0) return 0;

	const currentTokens = estimateMessagesTokens(messages);
	const usable = limits.contextWindow - limits.maxOutput;
	if (usable <= 0) return 1;

	return currentTokens / usable;
}

// =============================================================================
// Context Pruning
// =============================================================================

/**
 * Prune old tool result messages to free up context space.
 *
 * Algorithm (from OpenCode's SessionCompaction):
 * 1. Walk backwards through messages (newest first)
 * 2. Skip the most recent user turn
 * 3. For each tool result message:
 *    - Estimate its token count
 *    - Track running total of tool output tokens
 *    - If total > PRUNE_PROTECT (40K), mark for pruning
 * 4. If prunable tokens > PRUNE_MINIMUM (20K), execute the prune:
 *    - Replace tool result content with a placeholder
 *
 * Returns a new array of messages (does not mutate the original).
 */
export function pruneToolOutputs(messages: ModelMessage[]): { messages: ModelMessage[]; prunedTokens: number } {
	// Walk backwards to identify which tool result indices to prune
	const toolResultIndices: Array<{ index: number; tokens: number }> = [];
	let turns = 0;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];

		// Count user turns (skip the most recent one)
		if (message.role === 'user') {
			turns++;
		}

		// Only consider tool result messages past the first user turn
		if (message.role === 'tool' && turns >= 2) {
			const content = typeof message.content === 'string' ? message.content : JSON.stringify(message.content);
			const tokens = estimateTokens(content);
			toolResultIndices.push({ index, tokens });
		}
	}

	// Determine which tool results to prune:
	// Keep the most recent PRUNE_PROTECT tokens worth of output, prune the rest
	let protectedTokens = 0;
	let prunableTokens = 0;
	const indicesToPrune = new Set<number>();

	// toolResultIndices is in reverse order (newest first),
	// so we protect the first entries and prune the rest
	for (const { index, tokens } of toolResultIndices) {
		if (protectedTokens < PRUNE_PROTECT) {
			protectedTokens += tokens;
		} else {
			indicesToPrune.add(index);
			prunableTokens += tokens;
		}
	}

	// Only prune if we'd save enough tokens
	if (prunableTokens < PRUNE_MINIMUM) {
		return { messages, prunedTokens: 0 };
	}

	// Create new message array with pruned tool outputs
	const prunedMessages = messages.map((message, index) => {
		if (indicesToPrune.has(index)) {
			return {
				...message,
				content: PRUNED_PLACEHOLDER,
			};
		}
		return message;
	});

	return { messages: prunedMessages, prunedTokens: prunableTokens };
}
