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
import { normalizeFunctionCallsFormat, parseToolCalls } from './tool-call-parser';

import type { AgentLogger } from '../agent-logger';
import type { AIModelId } from '@shared/constants';
import type { DefaultMessageMetadataByModality, ModelMessage, StreamChunk, TextOptions, Tool } from '@tanstack/ai';
import type { StructuredOutputOptions, StructuredOutputResult } from '@tanstack/ai/adapters';

// =============================================================================
// Context Window Limits
// =============================================================================

/**
 * Known context window sizes and max output tokens per model.
 * Uses Replicate model IDs (our canonical format).
 */
const MODEL_LIMITS: Record<string, { contextWindow: number; maxOutput: number }> = {
	'anthropic/claude-4.5-haiku': { contextWindow: 200_000, maxOutput: 8192 },
	'anthropic/claude-4-sonnet': { contextWindow: 200_000, maxOutput: 16_384 },
	'anthropic/claude-4.5-sonnet': { contextWindow: 200_000, maxOutput: 16_384 },
	'anthropic/claude-4-opus': { contextWindow: 200_000, maxOutput: 32_768 },
};

/**
 * Get context window limits for a model.
 * Accepts Replicate-format model IDs (e.g., "anthropic/claude-4.5-haiku").
 * Returns conservative defaults if the model is unknown.
 */
export function getModelLimits(modelId: string): { contextWindow: number; maxOutput: number } {
	return MODEL_LIMITS[modelId] ?? { contextWindow: 200_000, maxOutput: 8192 };
}

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

You can use multiple tools in sequence. After using a tool, you will receive the result and can continue your response.
When you're done and don't need to use any more tools, just provide your final response without any tool_use blocks.`;
}

// =============================================================================
// Text-Completion Tool Guidance (Replicate-specific)
// =============================================================================

/**
 * Additional system prompt guidance injected ONLY by the Replicate text-completion adapter.
 *
 * Because Replicate exposes Claude as a text-completion endpoint (not a Messages API),
 * tool calls are parsed from XML blocks in the model's text output. This means:
 *   - Tools are called sequentially (no native parallel tool calls)
 *   - Each tool call is a separate <tool_use> block
 *
 * This guidance steers the model toward `file_patch` for multi-edit scenarios, reducing
 * the number of sequential `file_edit` calls in a single agent iteration.
 *
 * This constant is NOT used by future adapters that support native tool calling
 * (e.g., Anthropic Messages API), where parallel tool calls make this unnecessary.
 */
const TEXT_COMPLETION_TOOL_GUIDANCE = `# Tool efficiency
Since tools are called sequentially, prefer efficient tool usage:
- When making multiple changes to the same file, prefer \`file_patch\` over multiple \`file_edit\` calls. The \`file_patch\` tool lets you express all changes to a file (or even multiple files) in a single tool call.
- Reserve \`file_edit\` for simple, single-change edits (e.g., one find-and-replace).
- When you need to make 2 or more changes to the same file, use \`file_patch\` instead.`;

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
		const messageId = this.generateId();
		const timestamp = Date.now();

		// Build system prompt with tool descriptions and text-completion-specific guidance
		const systemPromptParts = options.systemPrompts ?? [];
		const toolDescriptions = options.tools ? formatToolDescriptions(options.tools) : '';
		const fullSystemPrompt = [...systemPromptParts, toolDescriptions, TEXT_COMPLETION_TOOL_GUIDANCE].filter(Boolean).join('\n\n');

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
			messageId,
			role: 'assistant',
			model: this.model,
		};

		// Stream from Replicate.
		//
		// Streaming strategy: we emit TEXT_MESSAGE_CONTENT events for visible text
		// and suppress raw XML tool blocks from being streamed to the UI.
		//
		// To handle the `<tool_use>` tag potentially spanning token boundaries, we
		// maintain a small "pending buffer" of characters that could be the start of
		// a tag. Only when we're sure text isn't part of a tag do we emit it.
		//
		// States:
		//   1. STREAMING_TEXT: Emitting text tokens, watching for potential tag prefix
		//   2. INSIDE_TOOL_USE: Detected <tool_use>, accumulating silently
		let accumulatedOutput = '';
		let emittedUpTo = 0; // Index in accumulatedOutput up to which we've emitted text
		let insideToolUse = false;
		const TOOL_USE_OPEN = '<tool_use>';

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

				if (insideToolUse) {
					// Already inside a tool_use block — accumulate silently
					continue;
				}

				// Check whether the accumulated output now contains a <tool_use> tag.
				// We search from a safe starting position to avoid re-scanning.
				const searchStart = Math.max(0, emittedUpTo - TOOL_USE_OPEN.length + 1);
				const tagIndex = accumulatedOutput.indexOf(TOOL_USE_OPEN, searchStart);

				if (tagIndex !== -1) {
					// Found a complete tag — emit any text before it
					if (tagIndex > emittedUpTo) {
						const delta = accumulatedOutput.slice(emittedUpTo, tagIndex);
						if (delta) {
							yield {
								type: 'TEXT_MESSAGE_CONTENT',
								timestamp: Date.now(),
								messageId,
								delta,
								model: this.model,
							};
						}
					}
					emittedUpTo = tagIndex;
					insideToolUse = true;
					continue;
				}

				// No complete tag found. To avoid emitting characters that might be
				// part of a partial `<tool_use>` tag, we hold back up to
				// (TOOL_USE_OPEN.length - 1) characters from the end of the buffer.
				// This handles the case where tokens arrive as: "...<tool" + "_use>..."
				const safeEnd = accumulatedOutput.length - (TOOL_USE_OPEN.length - 1);
				if (safeEnd > emittedUpTo) {
					const delta = accumulatedOutput.slice(emittedUpTo, safeEnd);
					if (delta) {
						yield {
							type: 'TEXT_MESSAGE_CONTENT',
							timestamp: Date.now(),
							messageId,
							delta,
							model: this.model,
						};
					}
					emittedUpTo = safeEnd;
				}
			}

			// After stream ends, flush any remaining buffered text that wasn't emitted
			// because it was held back as a potential tag prefix
			if (!insideToolUse && emittedUpTo < accumulatedOutput.length) {
				const delta = accumulatedOutput.slice(emittedUpTo);
				if (delta) {
					yield {
						type: 'TEXT_MESSAGE_CONTENT',
						timestamp: Date.now(),
						messageId,
						delta,
						model: this.model,
					};
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
				messageId,
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

		// Emit TEXT_MESSAGE_END
		yield {
			type: 'TEXT_MESSAGE_END',
			timestamp: Date.now(),
			messageId,
			model: this.model,
		};

		// Normalize alternative tool call formats and parse tool calls
		const normalizedOutput = normalizeFunctionCallsFormat(accumulatedOutput);
		const { textParts, toolCalls } = parseToolCalls(normalizedOutput, this.logger);
		const hasToolCalls = toolCalls.length > 0;

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
