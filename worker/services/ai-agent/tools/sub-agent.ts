/**
 * Tool: sub_agent
 * Delegate a focused task to a sub-agent that runs its own agent loop
 * with a fresh context window. The sub-agent shares the same filesystem
 * and project context but operates independently.
 *
 * This enables the main agent to offload deep exploration, focused edits,
 * or research tasks without consuming its own context window.
 */

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { AIAgentService } from '../service';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { SubAgentActivity } from '@shared/agent-state';
import type { ChatMessage } from '@shared/types';
import type { ModelMessage } from 'ai';

// =============================================================================
// Constants
// =============================================================================

/** Hard iteration cap for sub-agents (much lower than the main loop). */
const SUB_AGENT_MAX_ITERATIONS = 30;

// =============================================================================
// Description
// =============================================================================

const DESCRIPTION = `Delegate a focused task to a sub-agent that runs its own independent agent loop with a fresh context window.

Use this tool when:
- You need to explore a large part of the codebase without filling your own context.
- You want to delegate a self-contained sub-task (e.g., "refactor this module", "find all usages of X").
- The task requires deep exploration that would consume too many tokens in your main context.

The sub-agent:
- Starts with a fresh context (does NOT inherit your conversation history).
- Has access to the same filesystem and project tools.
- Returns its final text response as the tool result.
- Cannot spawn its own sub-agents (no recursion).
- Cannot ask the user questions.

Provide a clear, specific prompt describing exactly what the sub-agent should do.`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'sub_agent',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'A clear, specific description of the task for the sub-agent to perform.',
			},
			context: {
				type: 'string',
				description: 'Optional additional context (e.g., relevant file paths, constraints) to help the sub-agent.',
			},
		},
		required: ['prompt'],
	},
};

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	const { projectRoot, projectId, sessionId, abortSignal } = context;
	const prompt = input.prompt;
	const additionalContext = input.context;

	if (context.isSubAgent) {
		return toolError(ToolErrorCode.NOT_ALLOWED, 'Sub-agents cannot spawn other sub-agents.');
	}

	if (!prompt || prompt.trim().length === 0) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'A non-empty prompt is required.');
	}

	sendEvent('status', { message: 'Delegating task to sub-agent...' });

	// Build the sub-agent's initial message
	let fullPrompt = prompt.trim();
	if (additionalContext && additionalContext.trim().length > 0) {
		fullPrompt += `\n\nAdditional context:\n${additionalContext.trim()}`;
	}

	const subAgentMessages: ModelMessage[] = [{ role: 'user', content: fullPrompt }];
	const subAgentChatMessages: ChatMessage[] = [
		{
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', content: fullPrompt }],
			createdAt: Date.now(),
		},
	];

	// Create a sub-agent service with minimal configuration:
	// - No session persistence (results are ephemeral)
	// - No steering messages (sub-agents run to completion)
	// - Code mode with the same model as the parent
	const { fsStub, model } = context;
	const subAgentService = new AIAgentService(
		projectRoot,
		projectId,
		fsStub,
		sessionId ? `${sessionId}-sub-${crypto.randomUUID().slice(0, 8)}` : undefined,
		'code',
		model,
		undefined, // no onPersistSession
		undefined, // no getSteeringMessages
		true, // isSubAgent — prevents recursive sub-agent spawning
	);

	const subAgentAbortController = new AbortController();

	// Forward parent abort to sub-agent
	const onParentAbort = () => subAgentAbortController.abort();
	abortSignal?.addEventListener('abort', onParentAbort, { once: true });

	let lastAssistantText = '';
	let iterationCount = 0;

	try {
		const stream = subAgentService.runAgentStream(subAgentMessages, subAgentChatMessages, subAgentAbortController);

		for await (const event of stream) {
			if (abortSignal?.aborted) break;

			switch (event.type) {
				case 'text-delta': {
					if (event.delta) {
						lastAssistantText += event.delta;
						forwardActivity(sendEvent, { kind: 'text-delta', delta: event.delta });
					}
					break;
				}

				case 'file-changed': {
					sendEvent('file_changed', {
						path: event.path,
						action: event.action,
						beforeContent: event.beforeContent,
						afterContent: event.afterContent,
					});
					if (queryChanges) {
						queryChanges.push({
							path: event.path,
							action: event.action === 'move' ? 'edit' : event.action,
							beforeContent: event.beforeContent,
							afterContent: event.afterContent,
							isBinary: false,
						});
					}
					break;
				}

				case 'turn-complete': {
					iterationCount++;
					sendEvent('status', { message: `Sub-agent working... (turn ${iterationCount})` });
					if (iterationCount >= SUB_AGENT_MAX_ITERATIONS) {
						subAgentAbortController.abort();
					}
					break;
				}

				case 'status': {
					sendEvent('status', { message: `Sub-agent: ${event.message}` });
					break;
				}

				// Forward sub-agent tool activity to the parent for UI visibility
				case 'tool-call-start': {
					forwardActivity(sendEvent, { kind: 'tool-start', toolName: event.toolName });
					break;
				}
				case 'tool-call-end': {
					forwardActivity(sendEvent, { kind: 'tool-end', toolName: event.toolName, isError: event.isError });
					break;
				}
				case 'tool-result': {
					forwardActivity(sendEvent, {
						kind: 'tool-metadata',
						toolName: event.toolName,
						title: event.title,
						metadata: event.metadata,
					});
					break;
				}

				default: {
					break;
				}
			}

			if (iterationCount >= SUB_AGENT_MAX_ITERATIONS) break;
		}
	} finally {
		abortSignal?.removeEventListener('abort', onParentAbort);
	}

	// Flush the sub-agent's debug log so it can be downloaded from the UI
	let debugLogId: string | undefined;
	try {
		await subAgentService.flushLogger();
		debugLogId = subAgentService.getLogger()?.id;
		if (debugLogId) {
			forwardActivity(sendEvent, { kind: 'debug-log', debugLogId });
		}
	} catch {
		// Non-fatal — don't let logging failures break the tool result
	}

	const resultText = lastAssistantText.trim() || '(Sub-agent completed without producing text output)';
	const truncatedResult = resultText.length > 50_000 ? resultText.slice(0, 50_000) + '\n... (output truncated)' : resultText;

	// Derive a short title from the prompt for the tool UI
	const shortTitle = deriveShortTitle(prompt);

	return {
		title: `${shortTitle} (${iterationCount} turn${iterationCount === 1 ? '' : 's'})`,
		metadata: {
			iterations: iterationCount,
			outputLength: resultText.length,
			debugLogId,
			shortTitle,
		},
		output: truncatedResult,
	};
}

/**
 * Derive a short title from the sub-agent prompt for the tool UI.
 * Truncates at ~60 chars on a word boundary.
 */
function deriveShortTitle(prompt: string): string {
	const maxLength = 60;
	const cleaned = prompt.trim().replaceAll(/\s+/g, ' ');
	if (cleaned.length <= maxLength) return cleaned;
	const truncated = cleaned.slice(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');
	return (lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated) + '…';
}

/**
 * Forward a sub-agent activity event to the parent's event queue.
 * Uses the parent's toolCallId (auto-injected by createSendEvent).
 */
function forwardActivity(sendEvent: SendEventFunction, activity: SubAgentActivity): void {
	sendEvent('sub_agent_activity', { activity });
}
