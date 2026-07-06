import { messagePartsToPromptText } from '@shared/chat-message-parts';

import type { ChatMessage, MessagePart } from '@shared/types';
import type { AssistantModelMessage, ModelMessage, ToolModelMessage } from 'ai';
const CHARACTERS_PER_TOKEN = 4;
const PRUNE_MINIMUM = 20_000;
const PRUNE_PROTECT = 40_000;
const PRUNED_PLACEHOLDER = '[Old tool result content cleared]';
const PRUNEABLE_INPUT_TOOLS = new Set(['codemode']);
const MICRO_COMPACTION_KEEP_RECENT_MESSAGES = 4;
const MICRO_COMPACTION_MAX_TOOL_OUTPUT_CHARACTERS = 2000;
const MICRO_COMPACTION_MAX_TEXT_CHARACTERS = 4000;

/**
 * Buffer reserved for model output and system prompt overhead.
 * When usable context minus this buffer is exceeded, the agent should stop.
 */
const CONTEXT_BUDGET_BUFFER = 20_000;

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
			const text = messagePartsToPromptText(message.parts);
			const imageParts = message.parts.filter((part) => part.type === 'image');
			if (imageParts.length > 0) {
				const content: Array<{ type: 'text'; text: string } | { type: 'image'; image: string; mediaType?: string }> = [];
				if (text) {
					content.push({ type: 'text' as const, text });
				}
				for (const imagePart of imageParts) {
					content.push({ type: 'image' as const, image: imagePart.url, mediaType: imagePart.mediaType });
				}
				result.push({ role: 'user' as const, content });
			} else if (text) {
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

/**
 * Estimate token count from a string using the character heuristic.
 * This avoids a tokenizer dependency — accuracy is good enough for pruning decisions.
 */
function estimateTokens(text: string): number {
	return Math.round(text.length / CHARACTERS_PER_TOKEN);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function truncateText(text: string, maxCharacters: number): string {
	if (text.length <= maxCharacters) {
		return text;
	}

	return `${text.slice(0, maxCharacters)}... [truncated ${text.length} chars]`;
}

/**
 * Lightweight read-time micro-compaction applied before every model request.
 * This keeps recent messages intact while truncating oversized older text and
 * tool output payloads on a copy of the message list.
 */
export function microCompactMessages(
	messages: ModelMessage[],
	options?: {
		keepRecentMessages?: number;
		maxToolOutputCharacters?: number;
		maxTextCharacters?: number;
	},
): ModelMessage[] {
	const keepRecentMessages = options?.keepRecentMessages ?? MICRO_COMPACTION_KEEP_RECENT_MESSAGES;
	const maxToolOutputCharacters = options?.maxToolOutputCharacters ?? MICRO_COMPACTION_MAX_TOOL_OUTPUT_CHARACTERS;
	const maxTextCharacters = options?.maxTextCharacters ?? MICRO_COMPACTION_MAX_TEXT_CHARACTERS;

	if (messages.length <= keepRecentMessages) {
		return messages;
	}

	const cutoff = messages.length - keepRecentMessages;
	return messages.map((message, index): ModelMessage => {
		if (index >= cutoff) {
			return message;
		}

		if (typeof message.content === 'string') {
			const truncatedContent = truncateText(message.content, maxTextCharacters);
			if (truncatedContent === message.content || message.role === 'tool') {
				return message;
			}

			return { ...message, content: truncatedContent };
		}

		if (!Array.isArray(message.content)) {
			return message;
		}

		if (message.role === 'tool') {
			let changed = false;
			const truncatedToolContent = message.content.map((part) => {
				if (
					'output' in part &&
					isRecordObject(part.output) &&
					(part.output.type === 'text' || part.output.type === 'error-text') &&
					typeof part.output.value === 'string'
				) {
					const truncatedValue = truncateText(part.output.value, maxToolOutputCharacters);
					if (truncatedValue !== part.output.value) {
						changed = true;
						return { ...part, output: { ...part.output, value: truncatedValue } };
					}
				}

				return part;
			});

			return changed ? { ...message, content: truncatedToolContent } : message;
		}

		if (message.role === 'assistant') {
			let changed = false;
			const truncatedAssistantContent = message.content.map((part) => {
				if ('text' in part && typeof part.text === 'string') {
					const truncatedText = truncateText(part.text, maxTextCharacters);
					if (truncatedText !== part.text) {
						changed = true;
						return { ...part, text: truncatedText };
					}
				}

				return part;
			});

			return changed ? { ...message, content: truncatedAssistantContent } : message;
		}

		if (message.role === 'user') {
			let changed = false;
			const truncatedUserContent = message.content.map((part) => {
				if ('text' in part && typeof part.text === 'string') {
					const truncatedText = truncateText(part.text, maxTextCharacters);
					if (truncatedText !== part.text) {
						changed = true;
						return { ...part, text: truncatedText };
					}
				}

				return part;
			});

			return changed ? { ...message, content: truncatedUserContent } : message;
		}

		return message;
	});
}

interface SessionTokenMessage {
	parts?: Array<{ text?: string; reasoning?: string; input?: unknown; output?: unknown; result?: unknown }>;
}

/**
 * Token counter for the Agents SDK Session compaction. Counts the frozen
 * system prompt plus every message part using the same char heuristic the rest
 * of the agent uses, so the compaction trigger and boundary stay consistent.
 */
export function estimateSessionTokens(messages: readonly SessionTokenMessage[], systemPrompt: string): number {
	let total = estimateTokens(systemPrompt);
	for (const message of messages) {
		for (const part of message.parts ?? []) {
			if (typeof part.text === 'string') {
				total += estimateTokens(part.text);
			}
			if (typeof part.reasoning === 'string') {
				total += estimateTokens(part.reasoning);
			}
			for (const value of [part.input, part.output, part.result]) {
				if (value !== undefined && value !== null) {
					total += estimateTokens(typeof value === 'string' ? value : JSON.stringify(value));
				}
			}
		}
	}
	return total;
}

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

interface ModelLimits {
	contextWindow: number;
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
			// Preserve original toolCallId/toolName so the LLM's tool-call/result
			// pairing stays intact. Providers reject mismatched IDs.
			const originalContent = Array.isArray(message.content) ? message.content : [];
			const prunedContent = originalContent.map((part) => {
				if (part.type === 'tool-result') {
					return {
						type: 'tool-result' as const,
						toolCallId: part.toolCallId,
						toolName: part.toolName,
						output: { type: 'text' as const, value: PRUNED_PLACEHOLDER },
					};
				}
				return part;
			});
			return {
				role: 'tool' as const,
				content:
					prunedContent.length > 0
						? prunedContent
						: [
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

	// Second pass: prune tool call inputs for write operations whose results were pruned.
	// After a write succeeds, the full file content in the input is redundant.
	for (const prunedIndex of indicesToPrune) {
		const toolMessage = prunedMessages[prunedIndex];
		if (toolMessage.role !== 'tool' || !Array.isArray(toolMessage.content)) continue;

		for (const part of toolMessage.content) {
			if (part.type !== 'tool-result' || !PRUNEABLE_INPUT_TOOLS.has(part.toolName)) continue;

			// Find the preceding assistant message with the matching tool call
			for (let index = prunedIndex - 1; index >= 0; index--) {
				const candidate = prunedMessages[index];
				if (candidate.role !== 'assistant' || !Array.isArray(candidate.content)) continue;

				const callPartIndex = candidate.content.findIndex((p) => p.type === 'tool-call' && p.toolCallId === part.toolCallId);
				if (callPartIndex === -1) continue;

				// Clone the assistant message and replace the input
				const clonedContent = [...candidate.content];
				const callPart = clonedContent[callPartIndex];
				if (callPart.type === 'tool-call') {
					const originalInput =
						callPart.input && typeof callPart.input === 'object' && !Array.isArray(callPart.input)
							? Object.fromEntries(Object.entries(callPart.input))
							: {};
					clonedContent[callPartIndex] = {
						...callPart,
						input: { __pruned: true, path: originalInput.path ?? '' },
					};
					prunedMessages[prunedIndex - (prunedIndex - index)] = { ...candidate, content: clonedContent };
				}
				break;
			}
		}
	}

	return { messages: prunedMessages, prunedTokens: prunableTokens };
}

/**
 * Prune old corrective system messages injected by the agent loop.
 * These are user-role messages starting with MUTATION_FAILURE_TAG or "SYSTEM:"
 * that are no longer relevant after several iterations.
 *
 * Only prunes messages older than the protected window (last 2 user turns).
 */
export function pruneSystemMessages(messages: ModelMessage[]): { messages: ModelMessage[]; prunedTokens: number } {
	// Find the boundary: protect the last 2 user turns
	let userTurns = 0;
	let protectBoundary = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === 'user') {
			userTurns++;
			if (userTurns >= 2) {
				protectBoundary = index;
				break;
			}
		}
	}

	let prunedTokens = 0;
	const result = messages.map((message, index): ModelMessage => {
		if (index >= protectBoundary) return message;
		if (message.role !== 'user' || typeof message.content !== 'string') return message;

		const isSystemMessage = message.content.startsWith('[MUTATION_FAILURE]') || message.content.startsWith('SYSTEM:');
		if (!isSystemMessage) return message;

		prunedTokens += estimateTokens(message.content);
		return { role: 'user' as const, content: PRUNED_PLACEHOLDER };
	});

	return { messages: result, prunedTokens };
}
const ASSISTANT_TEXT_TRUNCATE_LENGTH = 200;

/**
 * Truncate old assistant text parts to save context space.
 * Preserves:
 * - All messages within the most recent N user turns
 * - All tool-call and tool-result structure (never truncated)
 * - Only truncates text parts of old assistant messages
 *
 * This is a last-resort pruning step for extremely full context windows.
 */
export function pruneOldAssistantText(
	messages: ModelMessage[],
	protectRecentTurns = 3,
): { messages: ModelMessage[]; prunedTokens: number } {
	// Find the protection boundary
	let userTurns = 0;
	let protectBoundary = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index].role === 'user') {
			userTurns++;
			if (userTurns >= protectRecentTurns) {
				protectBoundary = index;
				break;
			}
		}
	}

	let prunedTokens = 0;
	const result = messages.map((message, index): ModelMessage => {
		if (index >= protectBoundary) return message;
		if (message.role !== 'assistant') return message;

		if (typeof message.content === 'string') {
			if (message.content.length <= ASSISTANT_TEXT_TRUNCATE_LENGTH) return message;
			prunedTokens += estimateTokens(message.content) - estimateTokens(message.content.slice(0, ASSISTANT_TEXT_TRUNCATE_LENGTH));
			return { ...message, content: message.content.slice(0, ASSISTANT_TEXT_TRUNCATE_LENGTH) + '... [truncated]' };
		}

		if (!Array.isArray(message.content)) return message;

		// Only truncate text parts, preserve tool-call parts
		let changed = false;
		const newContent = message.content.map((part) => {
			if (part.type !== 'text' || part.text.length <= ASSISTANT_TEXT_TRUNCATE_LENGTH) return part;
			changed = true;
			prunedTokens += estimateTokens(part.text) - estimateTokens(part.text.slice(0, ASSISTANT_TEXT_TRUNCATE_LENGTH));
			return { ...part, text: part.text.slice(0, ASSISTANT_TEXT_TRUNCATE_LENGTH) + '... [truncated]' };
		});

		return changed ? { ...message, content: newContent } : message;
	});

	return { messages: result, prunedTokens };
}
