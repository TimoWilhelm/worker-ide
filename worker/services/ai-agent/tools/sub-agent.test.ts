import { describe, expect, it, vi } from 'vitest';

import { execute } from './sub-agent';
import { createMockContext, createMockSendEvent } from './test-helpers';

import type { ToolExecutorContext } from '../types';

describe('sub_agent', () => {
	it('delegates to a facet sub-agent and forwards streamed activity', async () => {
		const sendEvent = createMockSendEvent();
		const queryChanges: Array<{
			path: string;
			action: 'create' | 'edit' | 'delete';
			beforeContent?: string;
			afterContent?: string;
			isBinary: boolean;
		}> = [];
		const executeTask = vi.fn(
			async (_projectId: string, _messages: unknown[], _model: string, callback: { pushEvent: (payload: string) => Promise<void> }) => {
				await callback.pushEvent(JSON.stringify({ type: 'text-delta', delta: 'Investigating...' }));
				await callback.pushEvent(JSON.stringify({ type: 'tool-call-start', toolCallId: 'tc-1', toolName: 'file_read' }));
				await callback.pushEvent(JSON.stringify({ type: 'tool-call-end', toolCallId: 'tc-1', toolName: 'file_read', result: 'ok' }));
				await callback.pushEvent(
					JSON.stringify({
						type: 'file-changed',
						path: 'src/example.ts',
						action: 'edit',
						beforeContent: 'old',
						afterContent: 'new',
						toolCallId: 'tc-1',
					}),
				);

				return {
					text: 'Sub-agent result',
					iterations: 2,
					debugLogId: 'debug-123',
				};
			},
		);
		const subAgent = { executeTask };
		const agentReference = {
			subAgent: vi.fn(async () => subAgent),
		};
		const indexArtifact = vi.fn(async () => {});
		const context = createMockContext({
			agentReference: agentReference as ToolExecutorContext['agentReference'],
			indexArtifact,
		});

		const result = await execute(
			{ prompt: 'Inspect the failing integration', context: 'Focus on src/example.ts' },
			sendEvent,
			context,
			queryChanges,
		);

		expect(agentReference.subAgent).toHaveBeenCalledOnce();
		expect(executeTask).toHaveBeenCalledOnce();
		expect(result.output).toContain('Sub-agent result');
		expect(result.metadata).toMatchObject({ iterations: 2, debugLogId: 'debug-123', artifactKey: expect.any(String) });
		expect(indexArtifact).toHaveBeenCalledOnce();
		expect(queryChanges).toEqual([
			{
				path: 'src/example.ts',
				action: 'edit',
				beforeContent: 'old',
				afterContent: 'new',
				isBinary: false,
			},
		]);

		expect(sendEvent.calls.some(([type, payload]) => type === 'status' && payload.message === 'Delegating task to sub-agent...')).toBe(
			true,
		);
		expect(sendEvent.calls.some(([type, payload]) => type === 'sub_agent_activity' && payload.activity.kind === 'text-delta')).toBe(true);
		expect(sendEvent.calls.some(([type]) => type === 'file_changed')).toBe(true);
	}, 15_000);
});
