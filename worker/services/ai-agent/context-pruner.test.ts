import { describe, expect, it } from 'vitest';

import { microCompactMessages } from './context-pruner';

import type { ModelMessage } from 'ai';

describe('microCompactMessages', () => {
	it('truncates older tool output while preserving recent messages', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'Investigate logs' },
			{
				role: 'tool',
				content: [
					{
						type: 'tool-result',
						toolCallId: 'tool-1',
						toolName: 'test_run',
						output: { type: 'text', value: 'x'.repeat(10_000) },
					},
				],
			},
			{ role: 'assistant', content: 'Recent answer should stay intact.' },
			{ role: 'user', content: 'Most recent instruction should stay intact.' },
		];

		const compacted = microCompactMessages(messages, { keepRecentMessages: 2, maxToolOutputCharacters: 500, maxTextCharacters: 500 });

		expect(compacted[1]).not.toEqual(messages[1]);
		const toolMessage = compacted[1];
		if (toolMessage && Array.isArray(toolMessage.content)) {
			const output = toolMessage.content[0];
			if (output && 'output' in output && output.output && typeof output.output === 'object' && 'value' in output.output) {
				expect(output.output.value).toContain('[truncated 10000 chars]');
			}
		}
		expect(compacted[2]).toEqual(messages[2]);
		expect(compacted[3]).toEqual(messages[3]);
	});
});
