/**
 * Integration tests for the user_question tool.
 *
 * Tests event emission, options formatting, and result structure.
 * No external dependencies to mock ��� this tool is self-contained.
 */

import { describe, expect, it } from 'vitest';

import { createMockContext, createMockSendEvent } from './test-helpers';
import { execute } from './user-question';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('user_question', () => {
	// ── Basic question ────────────────────────────────────────────────────

	it('returns question text in result', async () => {
		const result = await execute({ question: 'Which design do you prefer?' }, createMockSendEvent(), createMockContext());

		expect(result.metadata).toHaveProperty('question', 'Which design do you prefer?');
		expect(result.output).toContain('Which design do you prefer?');
		expect(result.output).toContain('user will respond');
	});

	// ── With options ──────────────────────────────────────────────────────

	it('includes options in result', async () => {
		const result = await execute({ question: 'Pick a color', options: 'red, blue, green' }, createMockSendEvent(), createMockContext());

		expect(result.metadata.options).toEqual(['red', 'blue', 'green']);
		expect(result.output).toContain('Suggested options: red, blue, green');
	});

	// ── Without options ───────────────────────────────────────────────────

	it('works without options', async () => {
		const result = await execute({ question: 'Open question' }, createMockSendEvent(), createMockContext());

		expect(result.metadata).toHaveProperty('question', 'Open question');
		expect(result.output).not.toContain('Suggested options');
	});

	// ── Event emission ────────────────────────────────────────────────────

	it('emits status event', async () => {
		const sendEvent = createMockSendEvent();

		await execute({ question: 'Test?' }, sendEvent, createMockContext());

		const statusEvent = sendEvent.calls.find(([type]) => type === 'status');
		expect(statusEvent).toBeDefined();
		expect(statusEvent![1]).toHaveProperty('message', 'Asking user...');
	});

	it('emits user_question event with question and options', async () => {
		const sendEvent = createMockSendEvent();

		await execute({ question: 'Choose?', options: 'A, B' }, sendEvent, createMockContext());

		const questionEvent = sendEvent.calls.find(([type]) => type === 'user_question');
		expect(questionEvent).toBeDefined();
		expect(questionEvent![1]).toHaveProperty('question', 'Choose?');
		expect(questionEvent![1]).toHaveProperty('options', 'A, B');
	});
});
