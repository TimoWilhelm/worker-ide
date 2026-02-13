/**
 * AI Agent Service.
 * Handles the Claude AI agent loop with filesystem tools.
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Replicate from 'replicate';

import {
	AGENT_TOOLS,
	AGENT_SYSTEM_PROMPT,
	AGENTS_MD_MAX_CHARACTERS,
	BINARY_EXTENSIONS,
	MCP_SERVERS,
	PLAN_MODE_SYSTEM_PROMPT,
	PLAN_MODE_TOOLS,
} from '@shared/constants';
import { todoItemSchema, toolInputSchemas, type ToolName } from '@shared/validation';

import { isPathSafe, isProtectedFile } from '../lib/path-utilities';

type TodoItem = { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'high' | 'medium' | 'low' };

// =============================================================================
// Types
// =============================================================================

interface AgentMessage {
	role: 'user' | 'assistant';
	content: ContentBlock[] | string;
}

interface TextBlock {
	type: 'text';
	text: string;
}

interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, string>;
}

type ContentBlock = TextBlock | ToolUseBlock;

interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
}

interface ClaudeResponse {
	id: string;
	type: string;
	role: string;
	content: ContentBlock[];
	stop_reason: string | null;
	stop_sequence: string | null;
}

interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | Uint8Array | null;
	afterContent: string | Uint8Array | null;
	isBinary: boolean;
}

interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	changes: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>;
}

// =============================================================================
// Utilities
// =============================================================================

function isBinaryFilePath(path: string): boolean {
	const extension = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
	return BINARY_EXTENSIONS.has(extension);
}

/**
 * Type guard for ToolName.
 */
function isToolName(name: string): name is ToolName {
	return name in toolInputSchemas;
}

/**
 * Type guard for checking if a value is a non-null object (not array).
 */
function isRecordObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== undefined && !Array.isArray(value) && value !== null;
}

/**
 * Safely extract the `response` property from an error object if it exists.
 */
function getErrorResponse(error: unknown): Response | undefined {
	if (isRecordObject(error) && 'response' in error) {
		const candidate = error.response;
		if (candidate instanceof Response) {
			return candidate;
		}
	}
	return undefined;
}

/**
 * Convert a buffer to Uint8Array safely without type assertions.
 */
function toUint8Array(buffer: Buffer | Uint8Array): Uint8Array {
	if (buffer instanceof Uint8Array) {
		return buffer;
	}
	return new Uint8Array(buffer);
}

/**
 * Validate tool input based on tool name.
 */
function validateToolInput(
	toolName: ToolName,
	input: unknown,
): { success: true; data: Record<string, unknown> } | { success: false; error: string } {
	const schema = toolInputSchemas[toolName];
	if (!schema) {
		return { success: false, error: `Unknown tool: ${toolName}` };
	}

	const result = schema.safeParse(input);
	if (!result.success) {
		const formatted = result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
		return { success: false, error: `Invalid input for ${toolName}: ${formatted}` };
	}

	return { success: true, data: result.data };
}

/**
 * Attempt to repair malformed JSON from model output.
 */
function repairToolCallJson(raw: string): string | undefined {
	let s = raw.trim();
	// Strip markdown code fences
	s = s.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
	try {
		JSON.parse(s);
		return s;
	} catch {
		// No-op
	}
	// Remove trailing commas before } or ]
	s = s.replaceAll(/,\s*([}\]])/g, '$1');
	try {
		JSON.parse(s);
		return s;
	} catch {
		// No-op
	}
	// Close unclosed braces
	let depth = 0;
	let inString = false;
	let escape = false;
	for (const ch of s) {
		if (escape) {
			escape = false;
			continue;
		}
		if (ch === '\\' && inString) {
			escape = true;
			continue;
		}
		if (ch === '"') {
			inString = !inString;
			continue;
		}
		if (!inString) {
			if (ch === '{') depth++;
			else if (ch === '}') depth--;
		}
	}
	if (depth > 0) {
		s += '}'.repeat(depth);
		try {
			JSON.parse(s);
			return s;
		} catch {
			// No-op
		}
	}
	return undefined;
}

/**
 * Parse API errors into structured format.
 * Return type uses null for `code` because the result is serialized to JSON via SSE.
 */
function parseApiError(error: unknown): { message: string; code: string | null } {
	const raw = error instanceof Error ? error.message : String(error);
	const response = getErrorResponse(error);
	const status = response?.status;

	let upstreamType: string | undefined;
	let upstreamMessage: string | undefined;
	try {
		const jsonMatch = raw.match(/\{[\s\S]*\}/);
		if (jsonMatch) {
			const parsed = JSON.parse(jsonMatch[0]);
			if (typeof parsed.detail === 'string') {
				const innerMatch = parsed.detail.match(/\{[\s\S]*\}/);
				if (innerMatch) {
					const inner = JSON.parse(innerMatch[0].replaceAll("'", '"'));
					upstreamType = inner?.error?.type || undefined;
					upstreamMessage = inner?.error?.message || parsed.detail;
				} else {
					upstreamMessage = parsed.detail;
				}
			}
			if (parsed?.error?.type) {
				upstreamType = parsed.error.type;
				upstreamMessage = parsed.error.message || upstreamMessage;
			}
		}
	} catch {
		// No-op
	}

	if (upstreamType === 'overloaded_error' || status === 529 || /overloaded/i.test(raw) || /529/.test(raw)) {
		return {
			message: upstreamMessage || 'The AI model is currently overloaded. Please try again in a moment.',
			code: 'OVERLOADED',
		};
	}
	if (upstreamType === 'rate_limit_error' || status === 429 || /rate.?limit/i.test(raw)) {
		return {
			message: upstreamMessage || 'Rate limit exceeded. Please wait before trying again.',
			code: 'RATE_LIMIT',
		};
	}
	if (upstreamType === 'authentication_error' || status === 401 || status === 403) {
		return {
			message: upstreamMessage || 'Authentication failed. The API token may be invalid or expired.',
			code: 'AUTH_ERROR',
		};
	}
	if (upstreamType === 'invalid_request_error' || status === 400) {
		return {
			message: upstreamMessage || 'The request was invalid.',
			code: 'INVALID_REQUEST',
		};
	}
	if (status && status >= 500) {
		return {
			message: upstreamMessage || 'The AI service encountered an internal error. Please try again.',
			code: 'SERVER_ERROR',
		};
	}
	if (error instanceof Error && error.name === 'AbortError') {
		return { message: 'Request was cancelled.', code: 'ABORTED' };
	}

	// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
	return { message: upstreamMessage || raw, code: null };
}

// =============================================================================
// AI Agent Service Class
// =============================================================================

export class AIAgentService {
	private mcpClients = new Map<string, Client>();

	constructor(
		private projectRoot: string,
		private projectId: string,
		private environment: Env,
		private sessionId?: string,
		private planMode = false,
	) {}

	/**
	 * Run the AI agent chat loop with streaming response.
	 */
	async runAgentChat(prompt: string, history: AgentMessage[], apiToken: string, signal?: AbortSignal): Promise<ReadableStream<Uint8Array>> {
		const encoder = new TextEncoder();
		const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
		const writer = writable.getWriter();

		const sendEvent = async (type: string, data: Record<string, unknown>) => {
			const event = `data: ${JSON.stringify({ type, ...data })}\n\n`;
			await writer.write(encoder.encode(event));
		};

		// Run agent loop in background
		this.runAgentLoop(writer, sendEvent, prompt, history, apiToken, signal).catch(async (error) => {
			if (error instanceof Error && error.name === 'AbortError') {
				try {
					await writer.close();
				} catch {
					// No-op
				}
				return;
			}
			console.error('Agent error:', error);
			try {
				const parsed = parseApiError(error);
				await sendEvent('error', { message: parsed.message, code: parsed.code });
				await writer.close();
			} catch {
				// No-op
			}
		});

		return readable;
	}

	private async runAgentLoop(
		writer: WritableStreamDefaultWriter<Uint8Array>,
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
		prompt: string,
		history: AgentMessage[],
		apiToken: string,
		signal?: AbortSignal,
	): Promise<void> {
		const queryChanges: FileChange[] = [];

		try {
			await sendEvent('status', { message: 'Starting...' });

			// Read AGENTS.md context if available
			const agentsContext = await this.readAgentsContext();

			const messages: Array<{ role: string; content: string | ContentBlock[] | ToolResultBlock[] }> = [];
			for (const message of history) {
				messages.push({ role: message.role, content: message.content });
			}
			messages.push({ role: 'user', content: prompt });

			let continueLoop = true;
			const maxIterations = 10;
			let iteration = 0;
			let hitIterationLimit = false;
			// Collect the final assistant text for plan mode
			let lastAssistantText = '';

			while (continueLoop && iteration < maxIterations) {
				if (signal?.aborted) {
					await sendEvent('status', { message: 'Interrupted' });
					break;
				}
				iteration++;
				await sendEvent('status', { message: this.planMode ? 'Researching...' : 'Thinking...' });

				const response = await this.callClaude(messages, apiToken, signal, agentsContext);
				if (!response) {
					throw new Error('Failed to get response from Claude');
				}

				let hasToolUse = false;
				const toolResults: ToolResultBlock[] = [];

				for (const block of response.content) {
					if (block.type === 'text') {
						await sendEvent('message', { content: block.text });
						lastAssistantText = block.text;
					} else if (block.type === 'tool_use') {
						hasToolUse = true;

						await sendEvent('tool_call', {
							tool: block.name,
							id: block.id,
							args: block.input,
						});

						const result = await this.executeAgentTool(block.name, block.input, sendEvent, apiToken, block.id, queryChanges);

						await sendEvent('tool_result', {
							tool: block.name,
							tool_use_id: block.id,
							result: typeof result === 'string' ? result : JSON.stringify(result),
						});

						toolResults.push({
							type: 'tool_result',
							tool_use_id: block.id,
							content: typeof result === 'string' ? result : JSON.stringify(result),
						});
					}
				}

				if (hasToolUse) {
					messages.push({ role: 'assistant', content: response.content }, { role: 'user', content: toolResults });
				} else {
					continueLoop = false;
				}

				if (response.stop_reason === 'end_turn' && !hasToolUse) {
					continueLoop = false;
				}

				await sendEvent('turn_complete', {});
			}

			// Detect whether the loop was cut short by the iteration limit
			// while the model still wanted to use tools (circuit breaker).
			if (continueLoop && iteration >= maxIterations && !signal?.aborted) {
				hitIterationLimit = true;
			}

			if (queryChanges.length > 0) {
				await this.createSnapshot(prompt, queryChanges, sendEvent);
			}

			// In plan mode, save the plan to the filesystem
			if (this.planMode && lastAssistantText.trim()) {
				await this.savePlan(lastAssistantText, prompt, sendEvent);
			}

			if (hitIterationLimit) {
				await sendEvent('max_iterations_reached', { iterations: maxIterations });
			}

			await sendEvent('done', {});
			await writer.close();
		} catch (error) {
			if (error instanceof Error && error.name === 'AbortError') {
				if (queryChanges.length > 0) {
					try {
						await this.createSnapshot(prompt, queryChanges, sendEvent);
					} catch {
						// No-op
					}
				}
				await writer.close();
				return;
			}
			console.error('Agent loop error:', error);
			if (queryChanges.length > 0) {
				try {
					await this.createSnapshot(prompt, queryChanges, sendEvent);
				} catch {
					// No-op
				}
			}
			const parsed = parseApiError(error);
			await sendEvent('error', { message: parsed.message, code: parsed.code });
			await writer.close();
		} finally {
			await this.closeMcpClients();
		}
	}

	private async callClaude(
		messages: Array<{ role: string; content: string | ContentBlock[] | ToolResultBlock[] }>,
		apiToken: string,
		signal?: AbortSignal,
		agentsContext?: string,
	): Promise<ClaudeResponse | undefined> {
		if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
		const replicate = new Replicate({ auth: apiToken });

		let formattedPrompt = '';
		for (const message of messages) {
			if (message.role === 'user') {
				if (typeof message.content === 'string') {
					formattedPrompt += `\n\nHuman: ${message.content}`;
				} else if (this.isToolResultArray(message.content)) {
					let resultsText = '';
					for (const result of message.content) {
						const resultContent =
							typeof result.content === 'string'
								? result.content.length > 2000
									? result.content.slice(0, 2000) + '\n... (truncated)'
									: result.content
								: JSON.stringify(result.content);
						resultsText += `\n[Tool Result for ${result.tool_use_id}]:\n${resultContent}\n[/Tool Result]`;
					}
					formattedPrompt += `\n\nHuman: ${resultsText}`;
				}
			} else if (message.role === 'assistant') {
				if (typeof message.content === 'string') {
					formattedPrompt += `\n\nAssistant: ${message.content}`;
				} else if (this.isContentBlockArray(message.content)) {
					let assistantText = '';
					for (const block of message.content) {
						if (block.type === 'text') {
							assistantText += block.text;
						} else if (block.type === 'tool_use') {
							assistantText += `\n<tool_use>\n{"name": "${block.name}", "input": ${JSON.stringify(block.input)}}\n</tool_use>`;
						}
					}
					formattedPrompt += `\n\nAssistant: ${assistantText}`;
				}
			}
		}
		formattedPrompt += '\n\nAssistant:';

		// Select tools based on plan mode
		const activeTools = this.planMode ? PLAN_MODE_TOOLS : AGENT_TOOLS;

		const toolsDescription = activeTools
			.map((t) => `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.input_schema.properties)}`)
			.join('\n');

		// Build system prompt with optional AGENTS.md context and plan mode addendum
		let systemPrompt = AGENT_SYSTEM_PROMPT;
		if (agentsContext) {
			systemPrompt += `\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`;
		}
		if (this.planMode) {
			systemPrompt += PLAN_MODE_SYSTEM_PROMPT;
		}

		const fullSystemPrompt = `${systemPrompt}

Available tools:
${toolsDescription}

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

		const fullPrompt = `${fullSystemPrompt}${formattedPrompt}`;

		let output = '';
		for await (const event of replicate.stream('anthropic/claude-4.5-haiku', {
			input: {
				prompt: fullPrompt,
				max_tokens: 4096,
				system_prompt: '',
			},
		})) {
			if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
			output += event.toString();
		}

		const content: ContentBlock[] = [];
		let lastIndex = 0;
		let toolUseCount = 0;
		const openTag = '<tool_use>';
		const closeTag = '</tool_use>';
		let searchFrom = 0;

		while (searchFrom < output.length) {
			const tagStart = output.indexOf(openTag, searchFrom);
			if (tagStart === -1) break;

			const jsonStart = tagStart + openTag.length;
			const tagEnd = output.indexOf(closeTag, jsonStart);
			if (tagEnd === -1) break;

			const jsonString = output.slice(jsonStart, tagEnd).trim();
			const blockEnd = tagEnd + closeTag.length;

			const textBefore = output.slice(lastIndex, tagStart).trim();
			if (textBefore) {
				content.push({ type: 'text', text: textBefore });
			}

			try {
				let parsed: string | undefined;
				try {
					JSON.parse(jsonString);
					parsed = jsonString;
				} catch {
					parsed = repairToolCallJson(jsonString);
				}
				if (parsed === undefined) {
					throw new Error('Unrecoverable JSON');
				}
				const toolData: { name: string; input?: Record<string, unknown>; [key: string]: unknown } = JSON.parse(parsed);
				let input: Record<string, unknown>;
				if (toolData.input != undefined && typeof toolData.input === 'object') {
					input = toolData.input;
				} else {
					const { name, input: _discard, ...rest } = toolData;
					void name;
					void _discard;
					input = rest;
				}

				const inputAsStrings: Record<string, string> = {};
				for (const [key, value] of Object.entries(input)) {
					inputAsStrings[key] = String(value);
				}
				content.push({
					type: 'tool_use',
					id: `tool_${Date.now()}_${toolUseCount++}`,
					name: toolData.name,
					input: inputAsStrings,
				});
			} catch (error) {
				console.error('Failed to parse tool use:', jsonString, error);
				content.push({ type: 'text', text: output.slice(tagStart, blockEnd) });
			}

			lastIndex = blockEnd;
			searchFrom = blockEnd;
		}

		const remainingText = output.slice(lastIndex).trim();
		if (remainingText) {
			content.push({ type: 'text', text: remainingText });
		}

		if (content.length === 0) {
			content.push({ type: 'text', text: output });
		}

		const hasToolUse = content.some((c) => c.type === 'tool_use');

		return {
			id: `resp_${Date.now()}`,
			type: 'message',
			role: 'assistant',
			content,
			stop_reason: hasToolUse ? 'tool_use' : 'end_turn',
			// eslint-disable-next-line unicorn/no-null -- JSON wire format from Claude API
			stop_sequence: null,
		};
	}

	private isToolResultArray(content: ContentBlock[] | ToolResultBlock[]): content is ToolResultBlock[] {
		return content.length > 0 && 'tool_use_id' in content[0];
	}

	private isContentBlockArray(content: ContentBlock[] | ToolResultBlock[]): content is ContentBlock[] {
		return content.length === 0 || !('tool_use_id' in content[0]);
	}

	private async repairToolCall(
		toolName: string,
		rawInput: unknown,
		error: string,
		apiToken: string,
	): Promise<Record<string, unknown> | undefined> {
		const tool = AGENT_TOOLS.find((t) => t.name === toolName);
		if (!tool) return undefined;

		const prompt = [
			`The model tried to call the tool "${toolName}" with the following input:`,
			JSON.stringify(rawInput),
			``,
			`This failed with the error:`,
			error,
			``,
			`The tool accepts the following schema:`,
			JSON.stringify(tool.input_schema),
			``,
			`Respond with ONLY the corrected JSON input object. No explanation, no markdown, no wrapping.`,
		].join('\n');

		try {
			const replicate = new Replicate({ auth: apiToken });
			let output = '';
			for await (const event of replicate.stream('anthropic/claude-4.5-haiku', {
				input: {
					prompt: `\n\nHuman: ${prompt}\n\nAssistant:`,
					max_tokens: 512,
					system_prompt: 'You are a JSON repair assistant. Output only valid JSON, nothing else.',
				},
			})) {
				output += event.toString();
			}

			const trimmed = output
				.trim()
				.replace(/^```(?:json)?\s*\n?/i, '')
				.replace(/\n?```\s*$/, '');
			const repaired: unknown = JSON.parse(trimmed);
			if (!isRecordObject(repaired)) return undefined;
			return repaired;
		} catch {
			return undefined;
		}
	}

	private async executeAgentTool(
		toolName: string,
		toolInput: Record<string, string>,
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
		apiToken: string,
		toolUseId?: string,
		queryChanges?: FileChange[],
	): Promise<string | object> {
		try {
			let validatedInput: Record<string, string> = toolInput;
			if (isToolName(toolName)) {
				let validation = validateToolInput(toolName, toolInput);
				if (!validation.success) {
					try {
						const repaired = await this.repairToolCall(toolName, toolInput, validation.error, apiToken);
						if (repaired) {
							validation = validateToolInput(toolName, repaired);
						}
					} catch {
						// No-op
					}
					if (!validation.success) {
						return { error: validation.error };
					}
				}
				const data: Record<string, string> = {};
				for (const [key, value] of Object.entries(validation.data)) {
					data[key] = String(value);
				}
				validatedInput = data;
			}

			// Plan mode defense-in-depth: reject editing tools
			if (this.planMode && ['write_file', 'delete_file', 'move_file'].includes(toolName)) {
				return { error: 'File editing tools are not available in Plan mode. Use read-only tools to research and produce a plan.' };
			}

			switch (toolName) {
				case 'list_files': {
					await sendEvent('status', { message: 'Listing files...' });
					const files = await this.listFilesRecursive(this.projectRoot);
					const filtered = files.filter((f) => !f.endsWith('/.initialized') && f !== '/.initialized' && !f.startsWith('/.snapshots/'));
					return { files: filtered };
				}

				case 'read_file': {
					const path = validatedInput.path;
					if (!isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					await sendEvent('status', { message: `Reading ${path}...` });
					try {
						const content = await fs.readFile(`${this.projectRoot}${path}`, 'utf8');
						return { path, content };
					} catch {
						return { error: `File not found: ${path}` };
					}
				}

				case 'write_file': {
					const path = validatedInput.path;
					const content = validatedInput.content;
					if (!isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					await sendEvent('status', { message: `Writing ${path}...` });

					const directory = path.slice(0, path.lastIndexOf('/'));
					if (directory) {
						await fs.mkdir(`${this.projectRoot}${directory}`, { recursive: true });
					}

					const isBinary = isBinaryFilePath(path);
					// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
					let beforeContent: string | Uint8Array | null = null;
					let action: 'create' | 'edit' = 'create';
					try {
						if (isBinary) {
							const buffer = await fs.readFile(`${this.projectRoot}${path}`);
							beforeContent = toUint8Array(buffer);
						} else {
							beforeContent = await fs.readFile(`${this.projectRoot}${path}`, 'utf8');
						}
						action = 'edit';
					} catch {
						action = 'create';
					}

					await fs.writeFile(`${this.projectRoot}${path}`, content);

					if (queryChanges) {
						queryChanges.push({
							path,
							action,
							beforeContent,
							afterContent: content,
							isBinary,
						});
					}

					// Trigger HMR
					const hmrId = this.environment.DO_HMR_COORDINATOR.idFromName(`hmr:${this.projectId}`);
					const hmrStub = this.environment.DO_HMR_COORDINATOR.get(hmrId);
					const isCSS = path.endsWith('.css');
					await hmrStub.fetch(
						new Request('http://internal/hmr/trigger', {
							method: 'POST',
							body: JSON.stringify({
								type: isCSS ? 'update' : 'full-reload',
								path,
								timestamp: Date.now(),
								isCSS,
							}),
						}),
					);

					await sendEvent('file_changed', {
						path,
						action,
						tool_use_id: toolUseId,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						beforeContent: isBinary ? null : beforeContent,
						// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
						afterContent: isBinary ? null : content,
						isBinary,
					});
					return { success: true, path, action };
				}

				case 'delete_file': {
					const path = validatedInput.path;
					if (!isPathSafe(this.projectRoot, path)) {
						return { error: 'Invalid file path' };
					}
					if (isProtectedFile(path)) {
						return { error: 'Cannot delete worker entry point - this file is required for the application to run' };
					}
					await sendEvent('status', { message: `Deleting ${path}...` });

					const isBinary = isBinaryFilePath(path);
					// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
					let beforeContent: string | Uint8Array | null = null;
					try {
						if (isBinary) {
							const buffer = await fs.readFile(`${this.projectRoot}${path}`);
							beforeContent = toUint8Array(buffer);
						} else {
							beforeContent = await fs.readFile(`${this.projectRoot}${path}`, 'utf8');
						}
					} catch {
						// No-op
					}

					try {
						await fs.unlink(`${this.projectRoot}${path}`);

						if (queryChanges) {
							queryChanges.push({
								path,
								action: 'delete',
								beforeContent,
								// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
								afterContent: null,
								isBinary,
							});
						}

						await sendEvent('file_changed', {
							path,
							action: 'delete',
							tool_use_id: toolUseId,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							beforeContent: isBinary ? null : beforeContent,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							afterContent: null,
							isBinary,
						});
						return { success: true, path, action: 'delete' };
					} catch {
						return { error: `Failed to delete: ${path}` };
					}
				}

				case 'move_file': {
					const fromPath = validatedInput.from_path;
					const toPath = validatedInput.to_path;
					if (!isPathSafe(this.projectRoot, fromPath)) {
						return { error: 'Invalid source path' };
					}
					if (!isPathSafe(this.projectRoot, toPath)) {
						return { error: 'Invalid destination path' };
					}
					if (isProtectedFile(fromPath)) {
						return { error: 'Cannot move protected file - this file is required for the application to run' };
					}
					await sendEvent('status', { message: `Moving ${fromPath} to ${toPath}...` });

					try {
						const isBinaryFrom = isBinaryFilePath(fromPath);
						const isBinaryTo = isBinaryFilePath(toPath);
						let content: string | Uint8Array;
						if (isBinaryFrom) {
							const buffer = await fs.readFile(`${this.projectRoot}${fromPath}`);
							content = toUint8Array(buffer);
						} else {
							content = await fs.readFile(`${this.projectRoot}${fromPath}`, 'utf8');
						}

						const destinationDirectory = toPath.slice(0, toPath.lastIndexOf('/'));
						if (destinationDirectory) {
							await fs.mkdir(`${this.projectRoot}${destinationDirectory}`, { recursive: true });
						}

						await fs.writeFile(`${this.projectRoot}${toPath}`, content);
						await fs.unlink(`${this.projectRoot}${fromPath}`);

						if (queryChanges) {
							queryChanges.push(
								{
									path: fromPath,
									action: 'delete',
									beforeContent: content,
									// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
									afterContent: null,
									isBinary: isBinaryFrom,
								},
								{
									path: toPath,
									action: 'create',
									// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
									beforeContent: null,
									afterContent: content,
									isBinary: isBinaryTo,
								},
							);
						}

						await sendEvent('file_changed', {
							path: fromPath,
							action: 'delete',
							tool_use_id: toolUseId,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							beforeContent: isBinaryFrom ? null : content,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							afterContent: null,
							isBinary: isBinaryFrom,
						});
						await sendEvent('file_changed', {
							path: toPath,
							action: 'create',
							tool_use_id: toolUseId,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							beforeContent: null,
							// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
							afterContent: isBinaryTo ? null : content,
							isBinary: isBinaryTo,
						});

						// Trigger HMR for the moved file
						const hmrId = this.environment.DO_HMR_COORDINATOR.idFromName(`hmr:${this.projectId}`);
						const hmrStub = this.environment.DO_HMR_COORDINATOR.get(hmrId);
						await hmrStub.fetch(
							new Request('http://internal/hmr/trigger', {
								method: 'POST',
								body: JSON.stringify({
									type: 'full-reload',
									path: toPath,
									timestamp: Date.now(),
								}),
							}),
						);

						return { success: true, from: fromPath, to: toPath };
					} catch (error) {
						return { error: `Failed to move file: ${String(error)}` };
					}
				}

				case 'search_cloudflare_docs': {
					const query = validatedInput.query;
					if (!query) {
						return { error: 'Query is required for search_cloudflare_docs' };
					}
					await sendEvent('status', { message: 'Searching Cloudflare docs...' });
					try {
						const result = await this.callMcpTool('cloudflare-docs', 'search_cloudflare_documentation', { query });
						return { result };
					} catch (error) {
						return { error: `Failed to search Cloudflare docs: ${String(error)}` };
					}
				}

				case 'get_todos': {
					await sendEvent('status', { message: 'Reading TODOs...' });
					const todos = await this.readTodos();
					return { todos };
				}

				case 'update_todos': {
					await sendEvent('status', { message: 'Updating TODOs...' });
					try {
						// The input may come as a stringified JSON from the model
						let todosRaw: unknown = toolInput.todos;
						if (typeof todosRaw === 'string') {
							try {
								todosRaw = JSON.parse(todosRaw);
							} catch {
								return { error: 'Invalid JSON for todos field' };
							}
						}
						if (!Array.isArray(todosRaw)) {
							return { error: 'todos must be an array' };
						}
						const validated: TodoItem[] = [];
						for (const item of todosRaw) {
							const parsed = todoItemSchema.safeParse(item);
							if (!parsed.success) {
								return { error: `Invalid TODO item: ${parsed.error.issues.map((issue) => issue.message).join(', ')}` };
							}
							validated.push(parsed.data);
						}
						await this.writeTodos(validated);
						return { success: true, count: validated.length, todos: validated };
					} catch (error) {
						return { error: `Failed to update TODOs: ${String(error)}` };
					}
				}

				default: {
					return { error: `Unknown tool: ${toolName}` };
				}
			}
		} catch (error) {
			console.error(`Tool execution error (${toolName}):`, error);
			return { error: String(error) };
		}
	}

	private async listFilesRecursive(directory: string, base = ''): Promise<string[]> {
		const files: string[] = [];
		try {
			const entries = await fs.readdir(directory, { withFileTypes: true });
			for (const entry of entries) {
				if (
					entry.name === '.ai-sessions' ||
					entry.name === '.snapshots' ||
					entry.name === '.initialized' ||
					entry.name === '.project-meta.json' ||
					entry.name === '.agent'
				)
					continue;
				const relativePath = base ? `${base}/${entry.name}` : `/${entry.name}`;
				if (entry.isDirectory()) {
					files.push(...(await this.listFilesRecursive(`${directory}/${entry.name}`, relativePath)));
				} else {
					files.push(relativePath);
				}
			}
		} catch (error) {
			if (base === '') {
				console.error('listFilesRecursive error:', error);
			}
		}
		return files;
	}

	private async createSnapshot(
		prompt: string,
		changes: FileChange[],
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
	): Promise<void> {
		const snapshotId = crypto.randomUUID().slice(0, 8);
		const snapshotDirectory = `${this.projectRoot}/.snapshots/${snapshotId}`;

		await fs.mkdir(snapshotDirectory, { recursive: true });

		// Deduplicate changes by path: if the same file is modified multiple
		// times in one agent turn, only the FIRST change captures the true
		// original state. Later changes would record intermediate AI content
		// as "beforeContent", which breaks revert.
		const savedPaths = new Set<string>();
		const deduplicatedChanges: Array<{ path: string; action: 'create' | 'edit' | 'delete' }> = [];

		for (const change of changes) {
			if (savedPaths.has(change.path)) continue;
			savedPaths.add(change.path);

			// Save beforeContent to the snapshot directory (only for edit/delete)
			if (change.action !== 'create' && change.beforeContent !== null) {
				const filePath = `${snapshotDirectory}${change.path}`;
				const directory = filePath.slice(0, filePath.lastIndexOf('/'));
				if (directory && directory !== snapshotDirectory) {
					await fs.mkdir(directory, { recursive: true });
				}
				await fs.writeFile(filePath, change.beforeContent);
			}

			deduplicatedChanges.push({ path: change.path, action: change.action });
		}

		const metadata: SnapshotMetadata = {
			id: snapshotId,
			timestamp: Date.now(),
			label: prompt.slice(0, 50) + (prompt.length > 50 ? '...' : ''),
			changes: deduplicatedChanges,
		};
		// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
		await fs.writeFile(`${snapshotDirectory}/metadata.json`, JSON.stringify(metadata, null, 2));

		await this.cleanupOldSnapshots(10);

		await sendEvent('snapshot_created', {
			id: snapshotId,
			label: metadata.label,
			timestamp: metadata.timestamp,
			changes: metadata.changes,
		});
	}

	private async cleanupOldSnapshots(keepCount: number): Promise<void> {
		const snapshotsDirectory = `${this.projectRoot}/.snapshots`;

		try {
			const entries = await fs.readdir(snapshotsDirectory);
			const snapshots: Array<{ id: string; timestamp: number }> = [];

			for (const entry of entries) {
				try {
					const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
					const metadataRaw = await fs.readFile(metadataPath, 'utf8');
					const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
					snapshots.push({ id: entry, timestamp: metadata.timestamp });
				} catch {
					// No-op
				}
			}

			snapshots.sort((a, b) => b.timestamp - a.timestamp);

			for (let index = keepCount; index < snapshots.length; index++) {
				await this.deleteDirectoryRecursive(`${snapshotsDirectory}/${snapshots[index].id}`);
			}
		} catch {
			// No-op
		}
	}

	private async deleteDirectoryRecursive(directoryPath: string): Promise<void> {
		try {
			const entries = await fs.readdir(directoryPath, { withFileTypes: true });
			for (const entry of entries) {
				const fullPath = `${directoryPath}/${entry.name}`;
				await (entry.isDirectory() ? this.deleteDirectoryRecursive(fullPath) : fs.unlink(fullPath));
			}
			await fs.rmdir(directoryPath);
		} catch {
			// No-op
		}
	}

	// =============================================================================
	// AGENTS.md Context
	// =============================================================================

	private async readAgentsContext(): Promise<string | undefined> {
		try {
			const entries = await fs.readdir(this.projectRoot);
			const agentsFile = entries.find((entry) => entry.toLowerCase() === 'agents.md');
			if (!agentsFile) return undefined;

			let content = await fs.readFile(`${this.projectRoot}/${agentsFile}`, 'utf8');
			if (content.length > AGENTS_MD_MAX_CHARACTERS) {
				content = content.slice(0, AGENTS_MD_MAX_CHARACTERS) + '\n...(truncated)';
			}
			return content;
		} catch {
			return undefined;
		}
	}

	// =============================================================================
	// Plan Mode
	// =============================================================================

	private async savePlan(
		planContent: string,
		prompt: string,
		sendEvent: (type: string, data: Record<string, unknown>) => Promise<void>,
	): Promise<void> {
		try {
			const plansDirectory = `${this.projectRoot}/.agent/plans`;
			await fs.mkdir(plansDirectory, { recursive: true });

			const timestamp = Date.now();
			const planFileName = `${timestamp}-plan.md`;
			const planPath = `${plansDirectory}/${planFileName}`;

			const header = `# Plan: ${prompt.slice(0, 80)}${prompt.length > 80 ? '...' : ''}\n\n_Generated at ${new Date(timestamp).toISOString()}_\n\n---\n\n`;
			await fs.writeFile(planPath, header + planContent);

			await sendEvent('plan_created', {
				path: `/.agent/plans/${planFileName}`,
				content: planContent,
			});
		} catch (error) {
			console.error('Failed to save plan:', error);
		}
	}

	// =============================================================================
	// MCP Client
	// =============================================================================

	private async getMcpClient(serverId: string): Promise<Client> {
		const existing = this.mcpClients.get(serverId);
		if (existing) return existing;

		const serverConfig = MCP_SERVERS.find((server) => server.id === serverId);
		if (!serverConfig) {
			throw new Error(`Unknown MCP server: ${serverId}`);
		}

		const client = new Client({ name: 'worker-ide-agent', version: '1.0.0' });
		const transport = new StreamableHTTPClientTransport(new URL(serverConfig.endpoint));
		await client.connect(transport);

		this.mcpClients.set(serverId, client);
		return client;
	}

	private async callMcpTool(serverId: string, toolName: string, arguments_: Record<string, unknown>): Promise<string> {
		const client = await this.getMcpClient(serverId);
		const result = await client.callTool({ name: toolName, arguments: arguments_ });

		// Extract text content from the MCP result
		if (result.content && Array.isArray(result.content)) {
			const textParts: string[] = [];
			for (const item of result.content) {
				if (isRecordObject(item) && item.type === 'text' && typeof item.text === 'string') {
					textParts.push(item.text);
				}
			}
			if (textParts.length > 0) {
				return textParts.join('\n');
			}
		}

		return JSON.stringify(result.content);
	}

	private async closeMcpClients(): Promise<void> {
		for (const [serverId, client] of this.mcpClients) {
			try {
				await client.close();
			} catch {
				// No-op
			}
			this.mcpClients.delete(serverId);
		}
	}

	// =============================================================================
	// TODO Management
	// =============================================================================

	private getTodoFilePath(): string {
		const sessionId = this.sessionId || 'default';
		return `${this.projectRoot}/.agent/todo/${sessionId}.json`;
	}

	private async readTodos(): Promise<TodoItem[]> {
		try {
			const content = await fs.readFile(this.getTodoFilePath(), 'utf8');
			const parsed: unknown = JSON.parse(content);
			if (!Array.isArray(parsed)) return [];
			const validated: TodoItem[] = [];
			for (const item of parsed) {
				const result = todoItemSchema.safeParse(item);
				if (result.success) {
					validated.push(result.data);
				}
			}
			return validated;
		} catch {
			return [];
		}
	}

	private async writeTodos(todos: TodoItem[]): Promise<void> {
		const filePath = this.getTodoFilePath();
		const directory = filePath.slice(0, filePath.lastIndexOf('/'));
		await fs.mkdir(directory, { recursive: true });
		// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
		await fs.writeFile(filePath, JSON.stringify(todos, null, 2));
	}
}
