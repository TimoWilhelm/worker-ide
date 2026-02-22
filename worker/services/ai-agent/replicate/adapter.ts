/**
 * LLM adapter for the AI agent — custom Replicate adapter implementing TanStack AI TextAdapter.
 *
 * Routes all API calls through the Replicate proxy (using `replicate.stream()`).
 * Replicate exposes Claude models as text-completion endpoints, so this adapter:
 *   1. Converts ModelMessage[] → Human:/Assistant: formatted prompt
 *   2. Injects tool definitions + XML format instructions into the system prompt
 *   3. Streams tokens from Replicate, emitting AG-UI events
 *   4. Parses <tool_use> XML blocks from the accumulated output
 *   5. Emits TOOL_CALL_START/ARGS/END events and sets finishReason: 'tool_calls'
 */

import { convertSchemaToJsonSchema } from '@tanstack/ai';
import { BaseTextAdapter } from '@tanstack/ai/adapters';
import Replicate from 'replicate';

import { isRecordObject } from '../utilities';
import { extractNextCompleteToolBlock, normalizeFunctionCallsFormat, parseToolCalls, stripPartialToolCalls } from './tool-call-parser';

import type { AgentLogger } from '../agent-logger';
import type { AIModelId } from '@shared/constants';
import type { DefaultMessageMetadataByModality, ModelMessage, StreamChunk, TextOptions, Tool } from '@tanstack/ai';
import type { StructuredOutputOptions, StructuredOutputResult } from '@tanstack/ai/adapters';

// =============================================================================
// Message Formatting (Replicate text-completion format)
// =============================================================================

/**
 * Format a tool result content string, truncating if too long.
 */
function formatToolResultContent(content: unknown): string {
	const text = typeof content === 'string' ? content : JSON.stringify(content);
	if (text.length > 2000) {
		return text.slice(0, 2000) + '\n... (truncated)';
	}
	return text;
}

/**
 * Format tool calls as `<tool_use>` XML blocks for re-encoding into the prompt.
 * Ensures the arguments string is valid JSON to avoid prompt corruption.
 */
function formatToolCallsXml(toolCalls: ReadonlyArray<{ type: string; function: { name: string; arguments: string } }>): string {
	let xml = '';
	for (const toolCall of toolCalls) {
		if (toolCall.type !== 'function') continue;

		// Validate that arguments is valid JSON before embedding
		let argumentsJson = toolCall.function.arguments;
		try {
			JSON.parse(argumentsJson);
		} catch {
			// If arguments are invalid JSON, wrap as an object to prevent prompt corruption
			argumentsJson = '{}';
		}

		xml += `\n<tool_use>\n{"name": "${toolCall.function.name}", "input": ${argumentsJson}}\n</tool_use>`;
	}
	return xml;
}

/**
 * Pattern matching hallucinated turn markers in the model's text output.
 *
 * When using Replicate's text-completion endpoint, the model may continue
 * generating beyond its assistant turn — hallucinating a "Human:" turn
 * (often containing fake tool results) and then another "Assistant:" turn.
 * The Replicate Claude model schema does not support `stop_sequences`, so
 * we must detect these markers ourselves and truncate.
 *
 * Matches `\n\nHuman:` and the abbreviated `\n\nH:` form that the model
 * frequently uses. Requires a double newline prefix to avoid false positives
 * on content like "H: header" in normal text.
 */
const TURN_MARKER_PATTERN = /\n\nH(?:uman)?:\s/;

/**
 * Find the index of a hallucinated turn marker in the accumulated output.
 * Returns the index of the `\n\nH` prefix, or -1 if not found.
 */
function findTurnMarker(text: string): number {
	const match = TURN_MARKER_PATTERN.exec(text);
	return match ? match.index : -1;
}

/**
 * Convert TanStack AI ModelMessage[] into the Human:/Assistant: text prompt
 * format expected by Replicate's text-completion Claude endpoints.
 *
 * Handles:
 * - User messages with string or multipart (text/image) content
 * - Assistant messages with text content and/or tool calls
 * - Tool result messages formatted as Human: messages
 * - Content-less assistant messages (tool calls only)
 */
function formatMessages(messages: ReadonlyArray<ModelMessage>): string {
	let prompt = '';

	for (const message of messages) {
		switch (message.role) {
			case 'user': {
				if (typeof message.content === 'string') {
					prompt += `\n\nHuman: ${message.content}`;
				} else if (Array.isArray(message.content)) {
					const parts: string[] = [];
					for (const part of message.content) {
						if (typeof part === 'string') {
							parts.push(part);
						} else if (isRecordObject(part) && part.type === 'text' && typeof part.text === 'string') {
							parts.push(part.text);
						}
					}
					if (parts.length > 0) {
						prompt += `\n\nHuman: ${parts.join('\n')}`;
					}
				}
				break;
			}
			case 'assistant': {
				const textContent = typeof message.content === 'string' ? message.content : '';
				const toolCalls = message.toolCalls;
				const hasToolCalls = Array.isArray(toolCalls) && toolCalls.length > 0;

				if (textContent || hasToolCalls) {
					let text = textContent;
					if (hasToolCalls) {
						text += formatToolCallsXml(toolCalls);
					}
					prompt += `\n\nAssistant: ${text}`;
				}
				break;
			}
			case 'tool': {
				// Tool results are sent as user messages in text format
				const content = formatToolResultContent(message.content);
				const toolCallId = message.toolCallId ?? 'unknown';
				prompt += `\n\nHuman: [Tool Result for ${toolCallId}]:\n${content}\n[/Tool Result]`;
				break;
			}
			// No default
		}
	}

	return prompt;
}

// =============================================================================
// Tool Description Formatting
// =============================================================================

/**
 * Convert TanStack AI Tool[] into text descriptions for the system prompt.
 * Replicate's text-completion endpoint doesn't support native tool calling,
 * so we embed tool descriptions and XML format instructions in the prompt.
 */
function formatToolDescriptions(tools: ReadonlyArray<Tool>): string {
	if (tools.length === 0) return '';

	const toolLines = tools.map((tool) => {
		// Use TanStack AI's schema converter to get a clean JSON Schema from Zod/Standard Schema
		let propertiesText = '{}';
		try {
			const jsonSchema = convertSchemaToJsonSchema(tool.inputSchema);
			if (jsonSchema && isRecordObject(jsonSchema) && jsonSchema.properties) {
				propertiesText = JSON.stringify(jsonSchema.properties);
			}
		} catch {
			// No-op — fall back to empty properties
		}

		return `- ${tool.name}: ${tool.description}\n  Parameters: ${propertiesText}`;
	});

	return `Available tools:
${toolLines.join('\n')}

IMPORTANT: To use a tool, you MUST respond with a JSON block in this EXACT format:
<tool_use>
{"name": "tool_name", "input": {"param1": "value1"}}
</tool_use>

CRITICAL FORMAT RULES:
- All parameters MUST be nested inside the "input" object
- Example for write_file: {"name": "write_file", "input": {"path": "/file.txt", "content": "hello"}}
- Example for read_file: {"name": "read_file", "input": {"path": "/file.txt"}}
- NEVER put parameters at the top level like {"name": "write_file", "path": "..."} - this is WRONG

IMPORTANT: You MUST use exactly ONE tool per response. Do NOT include multiple tool_use blocks.
After using a tool, you will receive the result and can decide your next action in a follow-up response.
When you're done and don't need to use any more tools, just provide your final response without any tool_use blocks.`;
}

// =============================================================================
// Replicate Text Adapter
// =============================================================================

/**
 * Custom TanStack AI adapter for Replicate text-completion Claude endpoints.
 *
 * Replicate proxies Claude models as text-completion endpoints, so this adapter handles:
 * - Message formatting (Human:/Assistant: prompt format)
 * - Tool descriptions in system prompt (XML format)
 * - Streaming token emission as AG-UI events
 * - Post-stream parsing of <tool_use> XML blocks
 */
class ReplicateTextAdapter extends BaseTextAdapter<string, Record<string, never>, readonly ['text'], DefaultMessageMetadataByModality> {
	readonly name = 'replicate';
	private replicate: Replicate;
	private logger?: AgentLogger;

	constructor(apiKey: string, model: string, logger?: AgentLogger) {
		super({ apiKey }, model);
		this.replicate = new Replicate({ auth: apiKey });
		this.logger = logger;
	}

	async *chatStream(options: TextOptions<Record<string, never>>): AsyncIterable<StreamChunk> {
		const runId = this.generateId();
		let currentMessageId = this.generateId();
		const timestamp = Date.now();

		// Build system prompt with tool descriptions and text-completion-specific guidance
		const systemPromptParts = options.systemPrompts ?? [];
		const toolDescriptions = options.tools ? formatToolDescriptions(options.tools) : '';
		const fullSystemPrompt = [...systemPromptParts, toolDescriptions].filter(Boolean).join('\n\n');

		// Format messages into Human:/Assistant: prompt
		const formattedMessages = formatMessages(options.messages);
		const fullPrompt = `${fullSystemPrompt}${formattedMessages}\n\nAssistant:`;

		this.logger?.debug('llm', 'prompt_built', {
			promptLength: fullPrompt.length,
			systemPromptLength: fullSystemPrompt.length,
			messageCount: options.messages.length,
			toolCount: options.tools?.length ?? 0,
			maxTokens: options.maxTokens ?? 4096,
		});

		// Emit RUN_STARTED
		yield {
			type: 'RUN_STARTED',
			timestamp,
			runId,
			model: this.model,
		};

		// Emit TEXT_MESSAGE_START
		yield {
			type: 'TEXT_MESSAGE_START',
			timestamp: Date.now(),
			messageId: currentMessageId,
			role: 'assistant',
			model: this.model,
		};

		// Stream from Replicate.
		//
		// Streaming strategy: we emit TEXT_MESSAGE_CONTENT events for visible text
		// and suppress raw XML tool blocks from being streamed to the UI.
		//
		// We use `stripPartialToolCalls` to completely remove any tool XML tags from the stream.
		// To handle tags spanning boundaries, we hold back a small buffer of characters.
		//
		// Incremental tool call detection:
		// As the model output accumulates, we normalize alternative XML formats
		// and check for complete `<tool_use>...</tool_use>` blocks. When found,
		// we immediately close the current text message and emit TOOL_CALL events,
		// then start a new text message for subsequent content. This ensures tool
		// calls appear in the UI in real-time, interleaved with text segments.
		//
		// Hallucinated turn detection:
		// Replicate's text-completion endpoint does not support stop sequences, so
		// the model can role-play the entire conversation — generating a tool call,
		// then a fake "Human:" / "H:" turn with hallucinated tool results, and
		// continuing as "Assistant:" again. We detect these turn markers and truncate
		// the output, discarding everything from the marker onward.
		let accumulatedOutput = '';
		let emittedCleanedUpTo = 0; // Index in the cleaned (tool-stripped) string up to which we've emitted
		const MAX_TAG_PREFIX_LENGTH = 30; // Longest opening tag + wiggle room

		// Track whether we already emitted a tool call inline during streaming.
		// We enforce max 1 tool call per response.
		let inlineToolCallEmitted = false;
		// Track the position in the raw accumulated output up to which we've
		// checked for (and possibly emitted) tool blocks. This lets incremental
		// detection pick up where it left off without re-scanning old content.
		let toolScanOffset = 0;

		try {
			for await (const event of this.replicate.stream(
				// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Replicate SDK requires `provider/model` template literal type
				this.model as `${string}/${string}`,
				{
					input: {
						prompt: fullPrompt,
						max_tokens: options.maxTokens ?? 4096,
						system_prompt: '',
					},
				},
			)) {
				const token = event.toString();
				accumulatedOutput += token;

				// Detect hallucinated turn markers (`\n\nHuman:` or `\n\nH:`) and
				// truncate output at that point, discarding the rest of the stream.
				const turnMarkerIndex = findTurnMarker(accumulatedOutput);
				if (turnMarkerIndex !== -1) {
					accumulatedOutput = accumulatedOutput.slice(0, turnMarkerIndex);
					this.logger?.warn('llm', 'hallucinated_turn_truncated', {
						truncatedAt: turnMarkerIndex,
					});
					break;
				}

				// ── Incremental tool call detection ──
				// Normalize the full accumulated output so that alternative XML
				// formats (`<function_calls>/<invoke>`) are converted to `<tool_use>`.
				// Then check if a complete `<tool_use>...</tool_use>` block exists
				// past the last scan offset.
				if (!inlineToolCallEmitted) {
					const normalizedSoFar = normalizeFunctionCallsFormat(accumulatedOutput);
					const extracted = extractNextCompleteToolBlock(normalizedSoFar, toolScanOffset);

					if (extracted) {
						// Found a complete tool block! Emit any remaining text
						// before the tool block, then emit tool call events.

						// First, flush any un-emitted cleaned text *before* the tool
						// block. We strip tool XML from the text-before portion only
						// (not the tool block itself) so the user sees clean text.
						if (extracted.textBefore) {
							const cleanedBefore = stripPartialToolCalls(extracted.textBefore);
							if (cleanedBefore) {
								yield {
									type: 'TEXT_MESSAGE_CONTENT',
									timestamp: Date.now(),
									messageId: currentMessageId,
									delta: cleanedBefore.slice(emittedCleanedUpTo > 0 ? 0 : 0),
									model: this.model,
								};
							}
						}

						// Close the current text message
						yield {
							type: 'TEXT_MESSAGE_END',
							timestamp: Date.now(),
							messageId: currentMessageId,
							model: this.model,
						};

						// Emit tool call events
						const toolCallId = this.generateId();
						const argumentsJson = JSON.stringify(extracted.toolCall.input);

						yield {
							type: 'TOOL_CALL_START',
							timestamp: Date.now(),
							toolCallId,
							toolName: extracted.toolCall.name,
							index: 0,
							model: this.model,
						};

						yield {
							type: 'TOOL_CALL_ARGS',
							timestamp: Date.now(),
							toolCallId,
							delta: argumentsJson,
							args: argumentsJson,
							model: this.model,
						};

						yield {
							type: 'TOOL_CALL_END',
							timestamp: Date.now(),
							toolCallId,
							toolName: extracted.toolCall.name,
							input: extracted.toolCall.input,
							model: this.model,
						};

						this.logger?.info('tool_parse', 'inline_tool_emitted', {
							toolName: extracted.toolCall.name,
							blockEnd: extracted.blockEnd,
						});

						inlineToolCallEmitted = true;

						// Start a new text message for any text after the tool block
						currentMessageId = this.generateId();
						yield {
							type: 'TEXT_MESSAGE_START',
							timestamp: Date.now(),
							messageId: currentMessageId,
							role: 'assistant',
							model: this.model,
						};

						// Reset text emission tracking — we'll re-derive cleaned
						// text from the remaining output after the tool block.
						// The remaining raw output after the tool block will be
						// streamed as new text content in subsequent loop iterations.
						emittedCleanedUpTo = 0;
						toolScanOffset = extracted.blockEnd;

						// Emit any text that already exists after the tool block
						const remainingRaw = normalizedSoFar.slice(extracted.blockEnd);
						if (remainingRaw.trim()) {
							const cleanedRemaining = stripPartialToolCalls(remainingRaw);
							if (cleanedRemaining) {
								yield {
									type: 'TEXT_MESSAGE_CONTENT',
									timestamp: Date.now(),
									messageId: currentMessageId,
									delta: cleanedRemaining,
									model: this.model,
								};
								emittedCleanedUpTo = cleanedRemaining.length;
							}
						}

						// Skip the normal text emission for this iteration
						continue;
					}
				}

				// ── Normal text streaming (no tool block detected yet) ──
				// Calculate the safe boundary up to which we can emit text.
				// Hold back characters near the end that could be part of an
				// incomplete XML tag (`<tool_use>...`) or a turn marker prefix
				// (`\n\nHuman: `). The turn marker is at most 10 chars, and XML
				// tags up to 30. We use the last `<` for XML holdback; for turn
				// markers we hold back a fixed 10 chars from the end to ensure
				// `\n\nHuman: ` is fully buffered before we decide to emit or truncate.
				if (inlineToolCallEmitted) {
					// After an inline tool call was emitted, stream any new text
					// from the remaining output after the tool block.
					const normalizedSoFar = normalizeFunctionCallsFormat(accumulatedOutput);
					const remainingRaw = normalizedSoFar.slice(toolScanOffset);
					if (remainingRaw) {
						const cleanedRemaining = stripPartialToolCalls(remainingRaw);
						if (cleanedRemaining.length > emittedCleanedUpTo) {
							const delta = cleanedRemaining.slice(emittedCleanedUpTo);
							if (delta) {
								yield {
									type: 'TEXT_MESSAGE_CONTENT',
									timestamp: Date.now(),
									messageId: currentMessageId,
									delta,
									model: this.model,
								};
							}
							emittedCleanedUpTo = cleanedRemaining.length;
						}
					}
				} else {
					const lastOpen = accumulatedOutput.lastIndexOf('<');
					const safeEnd =
						lastOpen !== -1 && accumulatedOutput.length - lastOpen <= MAX_TAG_PREFIX_LENGTH
							? lastOpen
							: Math.max(0, accumulatedOutput.length - 10);

					if (safeEnd > 0) {
						const chunkToProcess = accumulatedOutput.slice(0, safeEnd);
						const cleanedChunk = stripPartialToolCalls(chunkToProcess);

						if (cleanedChunk.length > emittedCleanedUpTo) {
							const delta = cleanedChunk.slice(emittedCleanedUpTo);
							if (delta) {
								yield {
									type: 'TEXT_MESSAGE_CONTENT',
									timestamp: Date.now(),
									messageId: currentMessageId,
									delta,
									model: this.model,
								};
							}
							emittedCleanedUpTo = cleanedChunk.length;
						}
					}
				}
			}

			// After stream ends, flush any remaining buffered text.
			if (inlineToolCallEmitted) {
				// Inline tool call was emitted — flush remaining text after the tool block
				const normalizedFull = normalizeFunctionCallsFormat(accumulatedOutput);
				const remainingRaw = normalizedFull.slice(toolScanOffset);
				if (remainingRaw) {
					const cleanedRemaining = stripPartialToolCalls(remainingRaw);
					if (cleanedRemaining.length > emittedCleanedUpTo) {
						const delta = cleanedRemaining.slice(emittedCleanedUpTo);
						if (delta) {
							yield {
								type: 'TEXT_MESSAGE_CONTENT',
								timestamp: Date.now(),
								messageId: currentMessageId,
								delta,
								model: this.model,
							};
						}
					}
				}
			} else {
				// No inline tool call — flush the full accumulated output
				const cleanedChunk = stripPartialToolCalls(accumulatedOutput);
				if (cleanedChunk.length > emittedCleanedUpTo) {
					const delta = cleanedChunk.slice(emittedCleanedUpTo);
					if (delta) {
						yield {
							type: 'TEXT_MESSAGE_CONTENT',
							timestamp: Date.now(),
							messageId: currentMessageId,
							delta,
							model: this.model,
						};
					}
				}
			}
		} catch (error) {
			this.logger?.error('llm', 'replicate_stream_error', {
				error: error instanceof Error ? error.message : String(error),
				accumulatedOutputLength: accumulatedOutput.length,
			});
			// Emit TEXT_MESSAGE_END before the error so the text message is properly closed
			yield {
				type: 'TEXT_MESSAGE_END',
				timestamp: Date.now(),
				messageId: currentMessageId,
				model: this.model,
			};
			// Emit RUN_ERROR — no RUN_FINISHED needed after this
			yield {
				type: 'RUN_ERROR',
				timestamp: Date.now(),
				runId,
				error: {
					message: error instanceof Error ? error.message : String(error),
				},
				model: this.model,
			};
			return;
		}

		// Emit TEXT_MESSAGE_END for the current (possibly post-tool-call) text segment
		yield {
			type: 'TEXT_MESSAGE_END',
			timestamp: Date.now(),
			messageId: currentMessageId,
			model: this.model,
		};

		// ── Post-stream tool call handling ──
		// If a tool call was already emitted inline during streaming, we're done
		// with tool call emission. Otherwise, fall back to the batch parsing
		// approach for cases where the tool block was truncated or arrived at
		// the very end of the stream (past the holdback buffer).
		let hasToolCalls = inlineToolCallEmitted;

		if (!inlineToolCallEmitted) {
			// Normalize alternative tool call formats and parse tool calls
			const normalizedOutput = normalizeFunctionCallsFormat(accumulatedOutput);
			const { textParts, toolCalls: parsedToolCalls } = parseToolCalls(normalizedOutput, this.logger);

			// Enforce single tool call per response — if the model emitted multiple
			// <tool_use> blocks despite the prompt instruction, only keep the first one.
			if (parsedToolCalls.length > 1) {
				this.logger?.warn('tool_parse', 'multiple_tool_calls_truncated', {
					requestedCount: parsedToolCalls.length,
					toolNames: parsedToolCalls.map((tc) => tc.name),
					keptTool: parsedToolCalls[0].name,
				});
			}
			const toolCalls = parsedToolCalls.length > 1 ? parsedToolCalls.slice(0, 1) : parsedToolCalls;
			hasToolCalls = toolCalls.length > 0;

			this.logger?.info('tool_parse', 'parse_result', {
				accumulatedOutputLength: accumulatedOutput.length,
				toolCallCount: toolCalls.length,
				toolNames: toolCalls.map((tc) => tc.name),
				textPartCount: textParts.length,
				wasNormalized: normalizedOutput !== accumulatedOutput,
			});

			// Log raw output snippet for debugging when no tool calls were found.
			// This helps diagnose format mismatches where the model emits tool calls
			// in an unrecognized XML format that the normalizer doesn't handle.
			if (!hasToolCalls && accumulatedOutput.length > 0) {
				this.logger?.debug('tool_parse', 'no_tools_raw_output', {
					rawOutputSnippet: accumulatedOutput.slice(0, 1000),
					rawOutputLength: accumulatedOutput.length,
					containsFunctionCalls: accumulatedOutput.includes('<function_calls>'),
					containsInvoke: accumulatedOutput.includes('<invoke'),
					containsToolUse: accumulatedOutput.includes('<tool_use>'),
				});
			}

			// If there are tool calls and there are text segments BETWEEN or AFTER tool blocks
			// that weren't streamed (because we stopped at the first <tool_use>), emit them
			// as additional text messages so they appear as separate TextParts in the UI.
			if (hasToolCalls && textParts.length > 1) {
				// The first textPart was already streamed. Emit the rest as new text messages.
				for (let index = 1; index < textParts.length; index++) {
					const interstitialText = textParts[index].trim();
					if (!interstitialText) continue;
					const interstitialMessageId = this.generateId();
					yield {
						type: 'TEXT_MESSAGE_START',
						timestamp: Date.now(),
						messageId: interstitialMessageId,
						role: 'assistant',
						model: this.model,
					};
					yield {
						type: 'TEXT_MESSAGE_CONTENT',
						timestamp: Date.now(),
						messageId: interstitialMessageId,
						delta: interstitialText,
						model: this.model,
					};
					yield {
						type: 'TEXT_MESSAGE_END',
						timestamp: Date.now(),
						messageId: interstitialMessageId,
						model: this.model,
					};
				}
			}

			// Emit tool call events — use generateId() for unique, collision-free IDs
			for (const [index, toolCall] of toolCalls.entries()) {
				const toolCallId = this.generateId();
				const argumentsJson = JSON.stringify(toolCall.input);

				yield {
					type: 'TOOL_CALL_START',
					timestamp: Date.now(),
					toolCallId,
					toolName: toolCall.name,
					index,
					model: this.model,
				};

				yield {
					type: 'TOOL_CALL_ARGS',
					timestamp: Date.now(),
					toolCallId,
					delta: argumentsJson,
					args: argumentsJson,
					model: this.model,
				};

				// Include the parsed input object — the ToolCallManager uses this to
				// override the accumulated string args with the canonical parsed form
				yield {
					type: 'TOOL_CALL_END',
					timestamp: Date.now(),
					toolCallId,
					toolName: toolCall.name,
					input: toolCall.input,
					model: this.model,
				};
			}
		}

		// Emit RUN_FINISHED
		yield {
			type: 'RUN_FINISHED',
			timestamp: Date.now(),
			runId,
			finishReason: hasToolCalls ? 'tool_calls' : 'stop',
			model: this.model,
		};
	}

	async structuredOutput(_options: StructuredOutputOptions<Record<string, never>>): Promise<StructuredOutputResult<unknown>> {
		throw new Error('Structured output is not supported by the Replicate text-completion adapter.');
	}
}

// =============================================================================
// Adapter Factory
// =============================================================================

/**
 * Create a TanStack AI Replicate text-completion adapter.
 *
 * Routes all API calls through the Replicate proxy.
 * The adapter handles message formatting, tool descriptions, streaming, and tool call parsing.
 *
 * @param modelId - Replicate model ID (e.g., "anthropic/claude-4.5-haiku")
 * @param apiKey - Replicate API token
 * @param logger - Optional debug logger for structured logging of LLM interactions
 */
export function createAdapter(modelId: AIModelId | string, apiKey: string, logger?: AgentLogger): ReplicateTextAdapter {
	return new ReplicateTextAdapter(apiKey, modelId, logger);
}
