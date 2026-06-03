import { describe, expect, it } from 'vitest';

import { estimateSessionTokens, microCompactMessages } from './context-pruner';

import type { ModelMessage } from 'ai';

describe('estimateSessionTokens', () => {
	it('counts the system prompt even with no messages', () => {
		// 'a' * 40 -> ~10 tokens at 4 chars/token.
		expect(estimateSessionTokens([], 'a'.repeat(40))).toBe(10);
	});

	it('counts text, reasoning, and tool input/output/result parts', () => {
		const tokens = estimateSessionTokens(
			[
				{
					parts: [
						{ text: 'x'.repeat(40) },
						{ reasoning: 'y'.repeat(40) },
						{ input: { value: 'z'.repeat(36) } },
						{ output: 'w'.repeat(40) },
					],
				},
			],
			'',
		);
		// text 10 + reasoning 10 + input (JSON ~48 chars -> 12) + output 10 = 42
		expect(tokens).toBeGreaterThanOrEqual(40);
	});

	it('grows with more messages, so it can drive the compaction boundary', () => {
		const small = estimateSessionTokens([{ parts: [{ text: 'hello world' }] }], '');
		const large = estimateSessionTokens([{ parts: [{ text: 'hello world'.repeat(100) }] }], '');
		expect(large).toBeGreaterThan(small);
	});
});

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
