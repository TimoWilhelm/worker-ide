/**
 * Context window management for the AI agent.
 *
 * 1. **Pruning** — erase old tool outputs when context is getting full
 * 2. **Context budget** — check if there's enough context remaining for another iteration
 * 3. **Message conversion** — convert ChatMessage[] to ModelMessage[] for the AI SDK
 *
 * The agent loop prunes proactively at ~70% utilization, then stops when budget is exhausted.
 */

import type { ChatMessage, MessagePart } from '@shared/types';
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';

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
// ChatMessage → ModelMessage Conversion
// =============================================================================

/**
 * Convert our app-owned ChatMessage[] to Vercel AI SDK ModelMessage[].
 *
 * This is the boundary between our message format and the AI SDK's format.
 * ChatMessage uses our MessagePart union; ModelMessage uses the AI SDK's part format.
 */
export function chatMessagesToModelMessages(messages: ChatMessage[]): ModelMessage[] {
	const result: ModelMessage[] = [];

	for (const message of messages) {
		if (message.role === 'user') {
			// Extract text content from user message parts
			const textParts = message.parts.filter((part) => part.type === 'text');
			const text = textParts.map((part) => part.content).join('\n');
			if (text) {
				result.push({ role: 'user' as const, content: text });
			}
		} else if (message.role === 'assistant') {
			// Separate text parts, tool call parts, and tool result parts
			const textContent: string[] = [];
			const toolCalls: Array<{
				toolCallId: string;
				toolName: string;
				input: unknown;
			}> = [];
			const toolResults: Array<{
				toolCallId: string;
				toolName: string;
				output: unknown;
				isError?: boolean;
			}> = [];

			for (const part of message.parts) {
				switch (part.type) {
					case 'text': {
						textContent.push(part.content);
						break;
					}
					case 'tool-call': {
						toolCalls.push({
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							input: part.arguments,
						});
						break;
					}
					case 'tool-result': {
						toolResults.push({
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							output: part.result,
							isError: part.isError,
						});
						break;
					}
					case 'reasoning': {
						// Reasoning parts are not sent to the model
						break;
					}
				}
			}

			if (toolCalls.length > 0) {
				// Assistant message with tool calls
				const assistantContent: Array<
					{ type: 'text'; text: string } | { type: 'tool-call'; toolCallId: string; toolName: string; input: unknown }
				> = [];
				if (textContent.length > 0) {
					assistantContent.push({ type: 'text' as const, text: textContent.join('\n') });
				}
				for (const tc of toolCalls) {
					assistantContent.push({
						type: 'tool-call' as const,
						toolCallId: tc.toolCallId,
						toolName: tc.toolName,
						input: tc.input,
					});
				}
				result.push({ role: 'assistant' as const, content: assistantContent });

				// Add tool result messages
				for (const tr of toolResults) {
					result.push({
						role: 'tool' as const,
						content: [
							{
								type: 'tool-result' as const,
								toolCallId: tr.toolCallId,
								toolName: tr.toolName,
								output: { type: 'text' as const, value: typeof tr.output === 'string' ? tr.output : JSON.stringify(tr.output) },
							},
						],
					});
				}
			} else if (textContent.length > 0) {
				// Text-only assistant message
				result.push({ role: 'assistant' as const, content: textContent.join('\n') });
			}
		}
	}

	return result;
}

// =============================================================================
// ResponseMessage → ChatMessage Conversion
// =============================================================================

/**
 * Convert Vercel AI SDK response messages (AssistantModelMessage | ToolModelMessage)
 * back to ChatMessage[] so the agent loop can append each turn's output to the
 * persistent chat history.
 *
 * Each LLM turn produces one ChatMessage. When an AssistantModelMessage with
 * tool-call parts is immediately followed by a ToolModelMessage, the tool-result
 * parts are merged into the same ChatMessage. This ensures the frontend renderer
 * can pair tool-call and tool-result parts within a single message.
 */
export function responseMessagesToChatMessages(messages: Array<AssistantModelMessage | ToolModelMessage>): ChatMessage[] {
	const result: ChatMessage[] = [];

	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];

		if (message.role === 'assistant') {
			const parts: MessagePart[] = [];
			const content = message.content;

			if (typeof content === 'string') {
				if (content) parts.push({ type: 'text', content });
			} else {
				for (const part of content) {
					switch (part.type) {
						case 'text': {
							if (part.text) parts.push({ type: 'text', content: part.text });
							break;
						}
						case 'tool-call': {
							const rawInput = part.input;
							const arguments_: Record<string, unknown> =
								rawInput !== undefined && rawInput !== null && typeof rawInput === 'object' && !Array.isArray(rawInput)
									? Object.fromEntries(Object.entries(rawInput))
									: { __raw: rawInput };
							parts.push({
								type: 'tool-call',
								toolCallId: part.toolCallId,
								toolName: part.toolName,
								arguments: arguments_,
							});
							break;
						}
						case 'reasoning': {
							if (part.text) {
								parts.push({ type: 'reasoning', content: part.text });
							}
							break;
						}
						// file, image, redacted-reasoning, tool-result — not used in our ChatMessage format
					}
				}
			}

			// Merge tool results from the following ToolModelMessage into this message.
			// The AI SDK always places the tool response immediately after the assistant message.
			const next = messages[index + 1];
			if (next?.role === 'tool') {
				for (const part of next.content) {
					if (part.type === 'tool-result') {
						const output = part.output;
						const isErrorOutput = output.type === 'error-text';
						const resultText =
							output.type === 'text' || output.type === 'error-text'
								? output.value
								: 'value' in output
									? JSON.stringify(output.value)
									: output.type;
						parts.push({
							type: 'tool-result',
							toolCallId: part.toolCallId,
							toolName: part.toolName,
							result: resultText,
							isError: isErrorOutput,
						});
					}
				}
				index++; // Skip the tool message — its parts are now merged above
			}

			if (parts.length > 0) {
				result.push({ id: crypto.randomUUID(), role: 'assistant', parts, createdAt: Date.now() });
			}
		} else if (message.role === 'tool') {
			// Standalone tool message (no preceding assistant) — convert to assistant message
			const parts: MessagePart[] = [];
			for (const part of message.content) {
				if (part.type === 'tool-result') {
					const output = part.output;
					const isErrorOutput = output.type === 'error-text';
					const resultText =
						output.type === 'text' || output.type === 'error-text'
							? output.value
							: 'value' in output
								? JSON.stringify(output.value)
								: output.type;
					parts.push({
						type: 'tool-result',
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						result: resultText,
						isError: isErrorOutput,
					});
				}
			}
			if (parts.length > 0) {
				result.push({ id: crypto.randomUUID(), role: 'assistant', parts, createdAt: Date.now() });
			}
		}
	}

	return result;
}

// =============================================================================
// Token Estimation
// =============================================================================

/**
 * Estimate token count from a string using the character heuristic.
 * This avoids a tokenizer dependency — accuracy is good enough for pruning decisions.
 */
function estimateTokens(text: string): number {
	return Math.round(text.length / CHARACTERS_PER_TOKEN);
}

/**
 * Estimate the total token count of a ModelMessage array.
 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
	let total = 0;
	for (const message of messages) {
		if (typeof message.content === 'string') {
			total += estimateTokens(message.content);
		} else if (Array.isArray(message.content)) {
			for (const part of message.content) {
				if ('text' in part && typeof part.text === 'string') {
					total += estimateTokens(part.text);
				}
				if ('input' in part && part.input) {
					total += estimateTokens(typeof part.input === 'string' ? part.input : JSON.stringify(part.input));
				}
				if ('output' in part && part.output) {
					total += estimateTokens(typeof part.output === 'string' ? part.output : JSON.stringify(part.output));
				}
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
	const prunedMessages = messages.map((message, index): ModelMessage => {
		if (indicesToPrune.has(index) && message.role === 'tool') {
			return {
				role: 'tool' as const,
				content: [
					{
						type: 'tool-result' as const,
						toolCallId: 'pruned',
						toolName: 'pruned',
						output: { type: 'text' as const, value: PRUNED_PLACEHOLDER },
					},
				],
			};
		}
		return message;
	});

	return { messages: prunedMessages, prunedTokens: prunableTokens };
}
