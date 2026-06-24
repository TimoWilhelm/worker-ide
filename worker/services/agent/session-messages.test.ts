import { describe, expect, it } from 'vitest';

import { chatMessageToSessionMessage, sessionMessagesToChatMessages } from './session-messages';

import type { ChatMessage } from '@shared/types';

describe('session message bridges', () => {
	it('converts chat messages to session messages and back', () => {
		const source: ChatMessage = {
			id: 'message-1',
			role: 'assistant',
			parts: [
				{ type: 'text', content: 'Hello world' },
				{ type: 'reasoning', content: 'Thinking...' },
				{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'lint_check', arguments: { path: 'src/app.tsx' } },
				{ type: 'tool-result', toolCallId: 'tool-1', toolName: 'lint_check', result: 'file contents', isError: false },
			],
			createdAt: 123,
		};

		const sessionMessage = chatMessageToSessionMessage(source);
		const roundTripped = sessionMessagesToChatMessages([sessionMessage])[0];

		expect(sessionMessage.id).toBe(source.id);
		expect(sessionMessage.role).toBe(source.role);
		expect(sessionMessage.parts).toHaveLength(4);
		expect(roundTripped.id).toBe(source.id);
		expect(roundTripped.role).toBe(source.role);
		expect(roundTripped.parts).toEqual([
			{ type: 'text', content: 'Hello world' },
			{ type: 'reasoning', content: 'Thinking...' },
			{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'lint_check', arguments: { path: 'src/app.tsx' } },
			{ type: 'tool-result', toolCallId: 'tool-1', toolName: 'lint_check', result: 'file contents', isError: false },
		]);
	});

	it('serializes structured tool results to json strings', () => {
		const source: ChatMessage = {
			id: 'message-2',
			role: 'assistant',
			parts: [{ type: 'tool-result', toolCallId: 'tool-2', toolName: 'lint_check', result: { passed: true }, isError: false }],
		};

		const roundTripped = sessionMessagesToChatMessages([chatMessageToSessionMessage(source)])[0];

		expect(roundTripped.parts).toEqual([
			{ type: 'tool-result', toolCallId: 'tool-2', toolName: 'lint_check', result: '{"passed":true}', isError: false },
		]);
	});
});
