/**
 * Tests for AI-powered session title generation.
 *
 * Mocks `cloudflare:workers` env.AI.run to test retry logic,
 * fallback behavior, and title cleaning without real API calls.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the module under test
// ---------------------------------------------------------------------------

const mockAiRun = vi.fn();

vi.mock('cloudflare:workers', () => ({
	env: {
		AI: {
			run: mockAiRun,
		},
	},
}));

// Import after mocks are set up
const { generateSessionTitle, deriveFallbackTitle } = await import('./title-generator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const USER_MESSAGE = 'Help me build a todo app with React and TypeScript';
const ASSISTANT_RESPONSE = 'I will create a React TypeScript todo application with add, delete, and toggle functionality.';

function mockSuccessfulResponse(title: string) {
	mockAiRun.mockResolvedValueOnce({ response: title });
}

function mockErrorResponse(message: string) {
	mockAiRun.mockRejectedValueOnce(new Error(message));
}

function mockTimeoutResponse() {
	// Never resolves — the timeout wrapper in title-generator will reject
	mockAiRun.mockReturnValueOnce(new Promise(() => {}));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('generateSessionTitle', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
	});

	it('returns an AI-generated title on success', async () => {
		mockSuccessfulResponse('React TypeScript Todo App');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe('React TypeScript Todo App');
		expect(mockAiRun).toHaveBeenCalledOnce();
	});

	it('cleans surrounding quotes from the title', async () => {
		mockSuccessfulResponse('"Building a Todo App"');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe('Building a Todo App');
	});

	it('removes common AI prefixes', async () => {
		mockSuccessfulResponse('Title: React Todo Application');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe('React Todo Application');
	});

	it('removes trailing period', async () => {
		mockSuccessfulResponse('React Todo Application.');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe('React Todo Application');
	});

	it('enforces max title length', async () => {
		const longTitle = 'A'.repeat(200);
		mockSuccessfulResponse(longTitle);
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title.length).toBeLessThanOrEqual(100);
	});

	it('falls back when AI returns empty response', async () => {
		mockSuccessfulResponse('');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe(deriveFallbackTitle(USER_MESSAGE));
		// Should NOT retry on empty response — it breaks out immediately
		expect(mockAiRun).toHaveBeenCalledOnce();
	});

	it('retries on transient errors and succeeds', async () => {
		mockErrorResponse('Service temporarily unavailable');
		mockSuccessfulResponse('React Todo App');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);

		// Advance past the first retry delay (1000ms)
		await vi.advanceTimersByTimeAsync(1000);

		const title = await promise;
		expect(title).toBe('React Todo App');
		expect(mockAiRun).toHaveBeenCalledTimes(2);
	});

	it('retries on timeout and succeeds on second attempt', async () => {
		mockTimeoutResponse();
		mockSuccessfulResponse('Todo App Title');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);

		// First attempt times out after 5000ms
		await vi.advanceTimersByTimeAsync(5000);
		// Retry delay: 1000ms
		await vi.advanceTimersByTimeAsync(1000);

		const title = await promise;
		expect(title).toBe('Todo App Title');
		expect(mockAiRun).toHaveBeenCalledTimes(2);
	});

	it('retries on rate limit errors', async () => {
		mockErrorResponse('429 Too Many Requests');
		mockSuccessfulResponse('Generated Title');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		await vi.advanceTimersByTimeAsync(1000);

		const title = await promise;
		expect(title).toBe('Generated Title');
		expect(mockAiRun).toHaveBeenCalledTimes(2);
	});

	it('retries on 5xx server errors', async () => {
		mockErrorResponse('500 Internal Server Error');
		mockSuccessfulResponse('Server Recovered Title');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		await vi.advanceTimersByTimeAsync(1000);

		const title = await promise;
		expect(title).toBe('Server Recovered Title');
		expect(mockAiRun).toHaveBeenCalledTimes(2);
	});

	it('uses exponential backoff for retries', async () => {
		mockErrorResponse('Service temporarily unavailable');
		mockErrorResponse('Service temporarily unavailable');
		mockSuccessfulResponse('Third Attempt Title');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);

		// First retry: 1000ms
		await vi.advanceTimersByTimeAsync(1000);
		// Second retry: 2000ms
		await vi.advanceTimersByTimeAsync(2000);

		const title = await promise;
		expect(title).toBe('Third Attempt Title');
		expect(mockAiRun).toHaveBeenCalledTimes(3);
	});

	it('falls back after exhausting all retries', async () => {
		// 4 failures = 1 initial + 3 retries = all attempts exhausted
		mockErrorResponse('Service temporarily unavailable');
		mockErrorResponse('Service temporarily unavailable');
		mockErrorResponse('Service temporarily unavailable');
		mockErrorResponse('Service temporarily unavailable');

		const promise = generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);

		// Advance through all retry delays: 1s + 2s + 4s
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(2000);
		await vi.advanceTimersByTimeAsync(4000);

		const title = await promise;
		expect(title).toBe(deriveFallbackTitle(USER_MESSAGE));
		expect(mockAiRun).toHaveBeenCalledTimes(4);
	});

	it('does not retry on non-transient errors', async () => {
		mockErrorResponse('Invalid authentication credentials');
		const title = await generateSessionTitle(USER_MESSAGE, ASSISTANT_RESPONSE);
		expect(title).toBe(deriveFallbackTitle(USER_MESSAGE));
		// Only 1 call — no retries for non-transient errors
		expect(mockAiRun).toHaveBeenCalledOnce();
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
