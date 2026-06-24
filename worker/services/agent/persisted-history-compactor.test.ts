import { describe, expect, it } from 'vitest';

import { compactHistoryForPersistence } from './persisted-history-compactor';

import type { ChatMessage } from '@shared/types';

describe('compactHistoryForPersistence', () => {
	it('truncates oversized tool results with a rerun note', () => {
		const history: ChatMessage[] = [
			{
				id: 'assistant-1',
				role: 'assistant',
				parts: [
					{
						type: 'tool-result',
						toolCallId: 'tool-1',
						toolName: 'lint_check',
						result: 'x'.repeat(20_000),
					},
				],
			},
		];

		const compacted = compactHistoryForPersistence(history);
		const toolResult = compacted[0]?.parts[0];

		expect(toolResult?.type).toBe('tool-result');
		if (toolResult?.type === 'tool-result') {
			expect(toolResult.result).toContain('tool result truncated for storage');
			expect(toolResult.result.length).toBeLessThan(
				history[0]?.parts[0]?.type === 'tool-result' ? history[0].parts[0].result.length : 20_000,
			);
		}
	});

	it('truncates oversized tool-call arguments but preserves the path hint', () => {
		const history: ChatMessage[] = [
			{
				id: 'assistant-2',
				role: 'assistant',
				parts: [
					{
						type: 'tool-call',
						toolCallId: 'tool-2',
						toolName: 'lint_fix',
						arguments: { path: 'src/app.ts', content: 'x'.repeat(20_000) },
					},
				],
			},
		];

		const compacted = compactHistoryForPersistence(history);
		const toolCall = compacted[0]?.parts[0];

		expect(toolCall?.type).toBe('tool-call');
		if (toolCall?.type === 'tool-call') {
			expect(toolCall.arguments).toMatchObject({
				__truncated: true,
				toolName: 'lint_fix',
				path: 'src/app.ts',
			});
		}
	});
});
