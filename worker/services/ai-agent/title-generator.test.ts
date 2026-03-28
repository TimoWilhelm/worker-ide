/**
 * Tests for AI-powered session title generation.
 *
 * Mocks Vercel AI SDK `generateText()` and the Workers AI adapter to test
 * title extraction, fallback behavior, and the isAiGenerated flag without
 * real API calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockGenerateText = vi.fn();

vi.mock('ai', () => ({
	generateText: (...arguments_: unknown[]) => mockGenerateText(...arguments_),
	jsonSchema: (schema: unknown) => schema,
	Output: { object: (config: unknown) => config },
}));

vi.mock('./workers-ai', () => ({
	createAdapter: () => ({}),
}));

// Import after mocks are set up
const { generateSessionTitle, deriveFallbackTitle } = await import('./title-generator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_MESSAGE = 'Help me build a todo app with React and TypeScript';

function mockStructuredResponse(title: string) {
	mockGenerateText.mockResolvedValueOnce({ output: { title } });
}

function mockGenerateTextError(message: string) {
	mockGenerateText.mockRejectedValueOnce(new Error(message));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateSessionTitle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns an AI-generated title on success', async () => {
		mockStructuredResponse('React TypeScript Todo App');
		const result = await generateSessionTitle(USER_MESSAGE);
		expect(result.title).toBe('React TypeScript Todo App');
		expect(result.isAiGenerated).toBe(true);
	});

	it('enforces max title length', async () => {
		mockStructuredResponse('A'.repeat(200));
		const result = await generateSessionTitle(USER_MESSAGE);
		expect(result.title.length).toBeLessThanOrEqual(100);
		expect(result.isAiGenerated).toBe(true);
	});

	it('falls back when AI returns empty title', async () => {
		mockStructuredResponse('');
		const result = await generateSessionTitle(USER_MESSAGE);
		expect(result.title).toBe(deriveFallbackTitle(USER_MESSAGE));
		expect(result.isAiGenerated).toBe(false);
	});

	it('falls back when AI returns whitespace-only title', async () => {
		mockStructuredResponse('   ');
		const result = await generateSessionTitle(USER_MESSAGE);
		expect(result.title).toBe(deriveFallbackTitle(USER_MESSAGE));
		expect(result.isAiGenerated).toBe(false);
	});

	it('falls back when generateText() throws an error', async () => {
		mockGenerateTextError('Service temporarily unavailable');
		const result = await generateSessionTitle(USER_MESSAGE);
		expect(result.title).toBe(deriveFallbackTitle(USER_MESSAGE));
		expect(result.isAiGenerated).toBe(false);
	});

	it('passes only the user message to generateText()', async () => {
		mockStructuredResponse('Test Title');
		await generateSessionTitle(USER_MESSAGE);
		expect(mockGenerateText).toHaveBeenCalledOnce();
		const callArguments = mockGenerateText.mock.calls[0][0];
		expect(callArguments.output).toBeDefined();
		expect(callArguments.messages).toHaveLength(1);
		expect(callArguments.messages[0].content).toBe(USER_MESSAGE);
	});

	it('truncates long user messages to 500 characters', async () => {
		const longMessage = 'A'.repeat(1000);
		mockStructuredResponse('Title for Long Message');
		await generateSessionTitle(longMessage);
		const callArguments = mockGenerateText.mock.calls[0][0];
		expect(callArguments.messages[0].content).toBe('A'.repeat(500));
	});
});

describe('deriveFallbackTitle', () => {
	it('returns "New chat" for empty messages', () => {
		expect(deriveFallbackTitle('')).toBe('New chat');
		expect(deriveFallbackTitle('   ')).toBe('New chat');
	});

	it('returns the full message when short enough', () => {
		expect(deriveFallbackTitle('Fix the login bug')).toBe('Fix the login bug');
	});

	it('truncates long messages with ellipsis', () => {
		const longMessage = 'A'.repeat(100);
		const result = deriveFallbackTitle(longMessage);
		expect(result).toBe('A'.repeat(50) + '...');
	});

	it('trims whitespace', () => {
		expect(deriveFallbackTitle('  hello world  ')).toBe('hello world');
	});
});
