/**
 * Unit tests for the stateless detectDoomLoop function.
 *
 * Tests the three detection strategies by constructing ModelMessage[] histories:
 * 1. Identical consecutive tool calls (exact name + input)
 * 2. Same-tool repetition (same tool, different inputs, excluding read-only)
 * 3. Mutation failure loop (consecutive iterations with MUTATION_FAILURE_TAG)
 */

import { describe, expect, it } from 'vitest';

import { detectDoomLoop, MUTATION_FAILURE_TAG } from './doom-loop';

import type { ModelMessage } from '@tanstack/ai';

// =============================================================================
// Test helpers — build ModelMessage[] histories
// =============================================================================

let toolCallCounter = 0;

/** Create tool call objects with auto-incrementing IDs. */
function makeToolCalls(calls: Array<{ name: string; arguments: Record<string, unknown> }>) {
	return calls.map((c) => ({
		id: `tc_${++toolCallCounter}`,
		type: 'function' as const,
		function: { name: c.name, arguments: JSON.stringify(c.arguments) },
	}));
}

/** Create an assistant message with one or more tool calls. */
function assistantWithTools(...calls: Array<{ name: string; arguments: Record<string, unknown> }>): ModelMessage {
	return {
		role: 'assistant',
		// eslint-disable-next-line unicorn/no-null -- ModelMessage.content requires null
		content: null,
		toolCalls: makeToolCalls(calls),
	};
}

/** Create a tool result message. */
function toolResult(toolCallId: string, content: string): ModelMessage {
	return { role: 'tool', content, toolCallId };
}

/** Create a user corrective message with the mutation failure tag. */
function mutationFailureMessage(): ModelMessage {
	return {
		role: 'user',
		content: `${MUTATION_FAILURE_TAG} SYSTEM: One or more mutation tools failed.`,
	};
}

/** Create a plain user message (no failure tag). */
function userMessage(content: string): ModelMessage {
	return { role: 'user', content };
}

/**
 * Build a single iteration of messages:
 * assistant (with toolCalls) → tool results → optional mutation failure user message.
 */
function buildIteration(
	calls: Array<{ name: string; arguments: Record<string, unknown> }>,
	options?: { mutationFailure?: boolean },
): ModelMessage[] {
	const toolCalls = makeToolCalls(calls);
	const assistant: ModelMessage = {
		role: 'assistant',
		// eslint-disable-next-line unicorn/no-null -- ModelMessage.content requires null
		content: null,
		toolCalls,
	};
	const messages: ModelMessage[] = [assistant];
	for (const tc of toolCalls) {
		messages.push(toolResult(tc.id, 'ok'));
	}
	if (options?.mutationFailure) {
		messages.push(mutationFailureMessage());
	}
	return messages;
}

// =============================================================================
// identical_calls (exact same name + arguments, N consecutive)
// =============================================================================

describe('identical_calls detection', () => {
	it('returns no doom loop when fewer than 3 identical calls', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('detects 3 identical consecutive tool calls', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('identical_calls');
		expect(result.toolName).toBe('file_read');
	});

	it('does not trigger for same tool with different inputs', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/c.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('does not trigger for different tool names', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_write', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('detects identical calls after many non-identical ones', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_write', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_delete', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/x.txt', old_string: 'a', new_string: 'b' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/x.txt', old_string: 'a', new_string: 'b' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/x.txt', old_string: 'a', new_string: 'b' } }]),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('identical_calls');
		expect(result.toolName).toBe('file_edit');
	});

	it('detects identical calls across multi-tool iterations', () => {
		// Each iteration has 2 tool calls; the last 3 calls across iterations are identical
		const messages: ModelMessage[] = [
			...buildIteration([
				{ name: 'file_read', arguments: { path: '/a.txt' } },
				{ name: 'file_edit', arguments: { path: '/x.txt' } },
			]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/x.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/x.txt' } }]),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('identical_calls');
		expect(result.toolName).toBe('file_edit');
	});
});

// =============================================================================
// same_tool_repetition (same tool N times, even with different inputs)
// =============================================================================

describe('same_tool_repetition detection', () => {
	it('returns no doom loop when fewer than 5 same-tool calls', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/d.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('detects 5 consecutive calls to the same mutation tool', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/e.txt' } }]),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('same_tool_repetition');
		expect(result.toolName).toBe('file_edit');
	});

	it('does not trigger when different tools are interleaved', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/e.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('excludes read-only tools from detection', () => {
		const readOnlyTools = new Set(['file_read']);
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/e.txt' } }]),
		];
		expect(detectDoomLoop(messages, readOnlyTools).isDoomLoop).toBe(false);
	});

	it('detects non-read-only tools even when readOnlyTools set is provided', () => {
		const readOnlyTools = new Set(['file_read']);
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/e.txt' } }]),
		];
		const result = detectDoomLoop(messages, readOnlyTools);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('same_tool_repetition');
		expect(result.toolName).toBe('file_edit');
	});
});

// =============================================================================
// mutation_failure_loop (MUTATION_FAILURE_TAG in consecutive iterations)
// =============================================================================

describe('mutation_failure_loop detection', () => {
	it('returns no doom loop when only 1 iteration has a mutation failure', () => {
		const messages: ModelMessage[] = [...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true })];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('detects 2 consecutive iterations with mutation failures', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }], { mutationFailure: true }),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('mutation_failure_loop');
	});

	it('does not trigger when an iteration had no mutation failure', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('detects mutation failure loop after an initial successful iteration', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }], { mutationFailure: true }),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('mutation_failure_loop');
	});

	it('does not trigger on user messages without the mutation failure tag', () => {
		const messages: ModelMessage[] = [
			assistantWithTools({ name: 'file_edit', arguments: { path: '/a.txt' } }),
			toolResult('tc_prev', 'ok'),
			userMessage('Please fix the bug'),
			assistantWithTools({ name: 'file_edit', arguments: { path: '/b.txt' } }),
			toolResult('tc_prev2', 'ok'),
			userMessage('Try again'),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('handles interleaved reads between mutation failures (regression)', () => {
		// Iteration 1: read + failed write (mutation failure)
		// Iteration 2: read + failed write (mutation failure)
		const messages: ModelMessage[] = [
			...buildIteration(
				[
					{ name: 'file_read', arguments: { path: '/src/app.tsx' } },
					{ name: 'file_write', arguments: { path: '/src/app.tsx' } },
				],
				{ mutationFailure: true },
			),
			...buildIteration(
				[
					{ name: 'file_read', arguments: { path: '/src/app.tsx' } },
					{ name: 'file_write', arguments: { path: '/src/app.tsx' } },
				],
				{ mutationFailure: true },
			),
		];
		const result = detectDoomLoop(messages);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('mutation_failure_loop');
	});
});

// =============================================================================
// Combined / edge-case scenarios
// =============================================================================

describe('combined detection', () => {
	it('identical_calls takes priority over mutation_failure_loop', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }], { mutationFailure: true }),
		];
		const result = detectDoomLoop(messages);
		// identical_calls is checked first
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('identical_calls');
	});

	it('returns no doom loop for an empty message history', () => {
		expect(detectDoomLoop([]).isDoomLoop).toBe(false);
	});

	it('returns no doom loop for messages with no tool calls', () => {
		const messages: ModelMessage[] = [
			{ role: 'user', content: 'Hello' },
			{ role: 'assistant', content: 'Hi there!' },
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('handles assistant messages with empty toolCalls array', () => {
		const messages: ModelMessage[] = [
			{ role: 'assistant', content: 'thinking...', toolCalls: [] },
			{ role: 'assistant', content: 'still thinking...', toolCalls: [] },
			{ role: 'assistant', content: 'done thinking', toolCalls: [] },
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});
});
