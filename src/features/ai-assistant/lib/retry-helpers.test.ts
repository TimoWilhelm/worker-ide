/**
 * Unit tests for AI retry helper functions.
 */

import { describe, expect, it } from 'vitest';

import { extractMessageText, findLastUserMessage, getRemoveAfterIndex, prepareRetry } from './retry-helpers';

import type { AgentContent, AgentMessage, ToolName } from '@shared/types';

// =============================================================================
// Test Helpers
// =============================================================================

function createTextMessage(role: 'user' | 'assistant', text: string): AgentMessage {
	return {
		role,
		content: [{ type: 'text', text }],
	};
}

function createToolUseMessage(role: 'assistant', toolName: ToolName): AgentMessage {
	return {
		role,
		content: [{ type: 'tool_use', id: '123', name: toolName, input: {} }],
	};
}

function createMixedMessage(role: 'user' | 'assistant', text: string, hasToolUse: boolean): AgentMessage {
	const content: AgentContent[] = [{ type: 'text', text }];
	if (hasToolUse) {
		content.push({ type: 'tool_use', id: '456', name: 'file_read', input: {} });
	}
	return { role, content };
}

// =============================================================================
// extractMessageText Tests
// =============================================================================

describe('extractMessageText', () => {
	it('should extract text from a simple text message', () => {
		const message = createTextMessage('user', 'Hello world');
		expect(extractMessageText(message)).toBe('Hello world');
	});

	it('should extract text from a message with multiple text blocks', () => {
		const message: AgentMessage = {
			role: 'user',
			content: [
				{ type: 'text', text: 'First line' },
				{ type: 'text', text: 'Second line' },
			],
		};
		expect(extractMessageText(message)).toBe('First line\nSecond line');
	});

	it('should ignore non-text blocks', () => {
		const message = createMixedMessage('assistant', 'Some text', true);
		expect(extractMessageText(message)).toBe('Some text');
	});

	it('should return empty string for message with no text blocks', () => {
		const message = createToolUseMessage('assistant', 'file_read');
		expect(extractMessageText(message)).toBe('');
	});
});

// =============================================================================
// findLastUserMessage Tests
// =============================================================================

describe('findLastUserMessage', () => {
	it('should find the last user message', () => {
		const history: AgentMessage[] = [
			createTextMessage('user', 'First'),
			createTextMessage('assistant', 'Response 1'),
			createTextMessage('user', 'Second'),
			createTextMessage('assistant', 'Response 2'),
		];
		const result = findLastUserMessage(history);
		expect(result).toBeDefined();
		expect(extractMessageText(result!)).toBe('Second');
	});

	it('should return undefined for empty history', () => {
		const result = findLastUserMessage([]);
		expect(result).toBeUndefined();
	});

	it('should return undefined when no user messages exist', () => {
		const history: AgentMessage[] = [createTextMessage('assistant', 'Only assistant')];
		const result = findLastUserMessage(history);
		expect(result).toBeUndefined();
	});

	it('should find user message when it is the last message', () => {
		const history: AgentMessage[] = [createTextMessage('user', 'Question')];
		const result = findLastUserMessage(history);
		expect(result).toBeDefined();
		expect(extractMessageText(result!)).toBe('Question');
	});
});

// =============================================================================
// getRemoveAfterIndex Tests
// =============================================================================

describe('getRemoveAfterIndex', () => {
	it('should return 0 for empty history', () => {
		expect(getRemoveAfterIndex([])).toBe(0);
	});

	it('should remove 2 messages when last is assistant (error during generation)', () => {
		const history: AgentMessage[] = [
			createTextMessage('user', 'First'),
			createTextMessage('assistant', 'Response'),
			createTextMessage('user', 'Second'),
			createTextMessage('assistant', 'Error response'), // This errored
		];
		// Should remove indices 2 and 3 (user message and error response)
		// So removeAfter should be 2 (keep indices 0 and 1)
		expect(getRemoveAfterIndex(history)).toBe(2);
	});

	it('should remove 1 message when last is user (error before assistant replied)', () => {
		const history: AgentMessage[] = [
			createTextMessage('user', 'First'),
			createTextMessage('assistant', 'Response'),
			createTextMessage('user', 'Second'), // Error occurred before reply
		];
		// Should remove index 2 only
		// So removeAfter should be 2 (keep indices 0 and 1)
		expect(getRemoveAfterIndex(history)).toBe(2);
	});

	it('should handle single user message', () => {
		const history: AgentMessage[] = [createTextMessage('user', 'Only message')];
		// Remove the user message (to avoid duplication when re-sent)
		expect(getRemoveAfterIndex(history)).toBe(0);
	});

	it('should handle single assistant message', () => {
		const history: AgentMessage[] = [createTextMessage('assistant', 'Only assistant')];
		// This is an edge case - remove 2 would be -1
		expect(getRemoveAfterIndex(history)).toBe(-1);
	});
});

// =============================================================================
// prepareRetry Tests
// =============================================================================

describe('prepareRetry', () => {
	it('should return undefined for empty history', () => {
		expect(prepareRetry([])).toBeUndefined();
	});

	it('should return undefined when no user messages exist', () => {
		const history: AgentMessage[] = [createTextMessage('assistant', 'Only assistant')];
		expect(prepareRetry(history)).toBeUndefined();
	});

	it('should return correct values when last message is assistant', () => {
		const history: AgentMessage[] = [createTextMessage('user', 'Hello'), createTextMessage('assistant', 'Error response')];
		const result = prepareRetry(history);
		expect(result).toBeDefined();
		expect(result!.promptText).toBe('Hello');
		expect(result!.removeAfterIndex).toBe(0);
	});

	it('should return correct values when last message is user', () => {
		const history: AgentMessage[] = [
			createTextMessage('user', 'First'),
			createTextMessage('assistant', 'Response'),
			createTextMessage('user', 'Second'),
		];
		const result = prepareRetry(history);
		expect(result).toBeDefined();
		expect(result!.promptText).toBe('Second');
		expect(result!.removeAfterIndex).toBe(2);
	});

	it('should handle complex conversation', () => {
		const history: AgentMessage[] = [
			createTextMessage('user', 'Create a file'),
			createMixedMessage('assistant', 'I will create the file', true),
			createTextMessage('user', 'Now edit it'),
			createTextMessage('assistant', 'Failed!'), // Error
		];
		const result = prepareRetry(history);
		expect(result).toBeDefined();
		expect(result!.promptText).toBe('Now edit it');
		expect(result!.removeAfterIndex).toBe(2);
	});
});
