/**
 * AI Agent Service.
 * Handles the Claude AI agent loop with streaming response.
 */

import fs from 'node:fs/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import Replicate from 'replicate';

import {
	AGENT_TOOLS,
	AGENT_SYSTEM_PROMPT,
	AGENTS_MD_MAX_CHARACTERS,
	MCP_SERVERS,
	PLAN_MODE_SYSTEM_PROMPT,
	PLAN_MODE_TOOLS,
} from '@shared/constants';

import { executeAgentTool } from './tool-executor';
import { isRecordObject, parseApiError, repairToolCallJson } from './utilities';

import type { AgentMessage, ClaudeResponse, ContentBlock, FileChange, SnapshotMetadata, ToolResultBlock } from './types';

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

			// Read the latest plan so implementation steps can reference it
			const latestPlan = this.planMode ? undefined : await this.readLatestPlan();

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

				const response = await this.callClaude(messages, apiToken, signal, agentsContext, latestPlan);
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

						const result = await executeAgentTool(
							block.name,
							block.input,
							sendEvent,
							apiToken,
							{
								projectRoot: this.projectRoot,
								projectId: this.projectId,
								environment: this.environment,
								planMode: this.planMode,
								sessionId: this.sessionId,
								callMcpTool: (serverId, toolName, arguments_) => this.callMcpTool(serverId, toolName, arguments_),
								repairToolCall: (toolName, rawInput, error, token) => this.repairToolCall(toolName, rawInput, error, token),
							},
							block.id,
							queryChanges,
						);

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
		latestPlan?: string,
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
		if (latestPlan) {
			systemPrompt += `\n\n## Active Implementation Plan\nFollow this plan for all implementation steps. Reference it to decide what to do next and mark steps as complete when done.\n\n${latestPlan}`;
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
	// Plan Context
	// =============================================================================

	private async readLatestPlan(): Promise<string | undefined> {
		try {
			const plansDirectory = `${this.projectRoot}/.agent/plans`;
			const entries = await fs.readdir(plansDirectory);
			const planFiles = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();
			if (planFiles.length === 0) return undefined;

			const latestFile = planFiles.at(-1);
			if (!latestFile) return undefined;

			const content = await fs.readFile(`${plansDirectory}/${latestFile}`, 'utf8');
			if (!content.trim()) return undefined;

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
}
