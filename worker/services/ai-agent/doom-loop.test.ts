/**
 * Unit tests for the stateless detectDoomLoop function.
 *
 * Tests the two detection strategies by constructing ModelMessage[] histories:
 * 1. Identical consecutive tool calls (exact name + input)
 * 2. Mutation failure loop (consecutive iterations with MUTATION_FAILURE_TAG)
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

	it('does NOT trigger for same mutation tool with different files (legitimate work)', () => {
		// Editing 5 different files in a row is normal behavior, not a doom loop
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/e.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
	});

	it('does NOT trigger for same read-only tool called many times with different inputs', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/c.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/d.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/e.txt' } }]),
		];
		expect(detectDoomLoop(messages).isDoomLoop).toBe(false);
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

// =============================================================================
// currentRunStartIndex (scoping to current agent run)
// =============================================================================

describe('currentRunStartIndex', () => {
	it('ignores identical tool calls from prior turns when startIndex is set', () => {
		// Simulate prior turn: 3 identical file_read calls (would normally trigger)
		const priorTurnMessages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		// Current turn: assistant replies with no tool calls
		const currentTurnMessages: ModelMessage[] = [{ role: 'assistant', content: 'Here is what the file contains...' }];

		const allMessages = [...priorTurnMessages, ...currentTurnMessages];

		// Without startIndex (legacy behavior) — triggers
		expect(detectDoomLoop(allMessages).isDoomLoop).toBe(true);

		// With startIndex pointing to current turn — does NOT trigger
		expect(detectDoomLoop(allMessages, priorTurnMessages.length).isDoomLoop).toBe(false);
	});

	it('detects identical calls within the current run even with prior history', () => {
		// Prior turn: different tool calls
		const priorTurnMessages: ModelMessage[] = [...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }])];
		// Current turn: 3 identical calls (should trigger)
		const currentTurnMessages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/b.txt' } }]),
		];

		const allMessages = [...priorTurnMessages, ...currentTurnMessages];
		const result = detectDoomLoop(allMessages, priorTurnMessages.length);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('identical_calls');
		expect(result.toolName).toBe('file_read');
	});

	it('does not trigger when prior + current calls total 3 but current has fewer', () => {
		// Prior turn: 2 identical calls
		const priorTurnMessages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		// Current turn: 1 identical call (total 3 across turns, but only 1 in current)
		const currentTurnMessages: ModelMessage[] = [...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }])];

		const allMessages = [...priorTurnMessages, ...currentTurnMessages];

		// Without startIndex — triggers (3 total)
		expect(detectDoomLoop(allMessages).isDoomLoop).toBe(true);

		// With startIndex — does NOT trigger (only 1 in current run)
		expect(detectDoomLoop(allMessages, priorTurnMessages.length).isDoomLoop).toBe(false);
	});

	it('still detects mutation failure loop across current run iterations', () => {
		// Prior turn: successful
		const priorTurnMessages: ModelMessage[] = [...buildIteration([{ name: 'file_edit', arguments: { path: '/a.txt' } }])];
		// Current turn: 2 consecutive mutation failures
		const currentTurnMessages: ModelMessage[] = [
			...buildIteration([{ name: 'file_edit', arguments: { path: '/b.txt' } }], { mutationFailure: true }),
			...buildIteration([{ name: 'file_edit', arguments: { path: '/c.txt' } }], { mutationFailure: true }),
		];

		const allMessages = [...priorTurnMessages, ...currentTurnMessages];
		// Mutation failure detection still uses full history (scans backwards),
		// but the successful prior iteration breaks the streak naturally
		const result = detectDoomLoop(allMessages, priorTurnMessages.length);
		expect(result.isDoomLoop).toBe(true);
		expect(result.reason).toBe('mutation_failure_loop');
	});

	it('handles startIndex at 0 (same as no argument)', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		expect(detectDoomLoop(messages, 0).isDoomLoop).toBe(true);
	});

	it('handles startIndex beyond message length gracefully', () => {
		const messages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
			...buildIteration([{ name: 'file_read', arguments: { path: '/a.txt' } }]),
		];
		// startIndex beyond messages — no tool calls to analyze
		expect(detectDoomLoop(messages, messages.length + 10).isDoomLoop).toBe(false);
	});

	it('does not false-positive when empty arguments from prior turns look identical', () => {
		// This is the exact scenario from the bug report: prior turn had tool calls
		// with empty arguments (non-streaming adapter), and current turn has none.
		const priorTurnMessages: ModelMessage[] = [
			...buildIteration([{ name: 'file_read', arguments: {} }]),
			...buildIteration([{ name: 'file_read', arguments: {} }]),
			...buildIteration([{ name: 'file_read', arguments: {} }]),
		];
		const currentTurnMessages: ModelMessage[] = [{ role: 'assistant', content: 'Here is the answer.' }];

		const allMessages = [...priorTurnMessages, ...currentTurnMessages];

		// Without startIndex — would trigger (3 identical empty-arg calls)
		expect(detectDoomLoop(allMessages).isDoomLoop).toBe(true);

		// With startIndex — does NOT trigger (no tool calls in current run)
		expect(detectDoomLoop(allMessages, priorTurnMessages.length).isDoomLoop).toBe(false);
	});
});
