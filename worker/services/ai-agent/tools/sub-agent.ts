import { ToolErrorCode, toolError } from '@shared/tool-errors';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { SubAgentActivity, StreamEvent } from '@shared/agent-state';
import type { ChatMessage } from '@shared/types';

export const definition: ToolDefinition = {
	name: 'sub_agent',
	description:
		'Delegate a focused task to a sub-agent with its own isolated storage and fresh context window. Use this for deep exploration or self-contained subtasks.',
	input_schema: {
		type: 'object',
		properties: {
			prompt: {
				type: 'string',
				description: 'A clear, specific description of the task for the sub-agent to perform.',
			},
			context: {
				type: 'string',
				description: 'Optional additional context (relevant file paths, constraints, or goals).',
			},
		},
		required: ['prompt'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	queryChanges?: FileChange[],
): Promise<ToolResult> {
	if (!context.agentReference) {
		return toolError(ToolErrorCode.NOT_ALLOWED, 'Sub-agents require an Agent context.');
	}

	const prompt = input.prompt?.trim();
	if (!prompt) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'A non-empty prompt is required.');
	}

	let fullPrompt = prompt;
	if (input.context?.trim()) {
		fullPrompt += `\n\nAdditional context:\n${input.context.trim()}`;
	}

	const messages: ChatMessage[] = [
		{
			id: crypto.randomUUID(),
			role: 'user',
			parts: [{ type: 'text', content: fullPrompt }],
			createdAt: Date.now(),
		},
	];

	const [{ SubAgentStreamCallback }, { SubAgentWorker }] = await Promise.all([
		import('../../../durable/sub-agent-stream-callback'),
		import('../../../durable/sub-agent-worker'),
	]);

	const callback = new SubAgentStreamCallback((event) => {
		handleSubAgentEvent(event, sendEvent, queryChanges);
	});

	sendEvent('status', { message: 'Delegating task to sub-agent...' });
	const subAgent = await context.agentReference.subAgent(SubAgentWorker, `sub-agent-${crypto.randomUUID().slice(0, 8)}`);
	const result = await subAgent.executeTask(context.projectId, messages, context.model, callback);

	if (result.debugLogId) {
		forwardActivity(sendEvent, { kind: 'debug-log', debugLogId: result.debugLogId });
	}

	const shortTitle = deriveShortTitle(prompt);
	return {
		title: `${shortTitle} (${result.iterations} turn${result.iterations === 1 ? '' : 's'})`,
		metadata: {
			iterations: result.iterations,
			outputLength: result.text.length,
			debugLogId: result.debugLogId,
			shortTitle,
		},
		output: result.text,
	};
}

function handleSubAgentEvent(event: StreamEvent, sendEvent: SendEventFunction, queryChanges?: FileChange[]): void {
	switch (event.type) {
		case 'text-delta': {
			forwardActivity(sendEvent, { kind: 'text-delta', delta: event.delta });
			break;
		}
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
		default: {
			break;
		}
	}
}

function deriveShortTitle(prompt: string): string {
	const maxLength = 60;
	const cleaned = prompt.trim().replaceAll(/\s+/g, ' ');
	if (cleaned.length <= maxLength) return cleaned;
	const truncated = cleaned.slice(0, maxLength);
	const lastSpace = truncated.lastIndexOf(' ');
	return `${lastSpace > 20 ? truncated.slice(0, lastSpace) : truncated}...`;
}

function forwardActivity(sendEvent: SendEventFunction, activity: SubAgentActivity): void {
	sendEvent('sub_agent_activity', { activity });
}
