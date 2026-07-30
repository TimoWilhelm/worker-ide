import { describe, expect, it } from 'vitest';

import { chatMessageToUiMessage, uiMessagesToChatMessages, userMessageToUiMessage } from './think-messages';

import type { ChatMessage } from '@shared/types';

describe('Think message conversion', () => {
	it('converts user text, preview references, and images', () => {
		const message: ChatMessage = {
			id: 'user-1',
			role: 'user',
			parts: [
				{ type: 'text', content: 'Inspect this' },
				{ type: 'preview-element', tagName: 'button', text: 'Save' },
				{ type: 'image', url: 'data:image/png;base64,abc', mediaType: 'image/png', name: 'screen.png' },
			],
		};

		expect(userMessageToUiMessage(message)).toMatchObject({
			id: 'user-1',
			role: 'user',
			parts: [
				{ type: 'text', text: 'Inspect this' },
				{ type: 'text' },
				{ type: 'file', url: 'data:image/png;base64,abc', mediaType: 'image/png', filename: 'screen.png' },
			],
		});
	});

	it('round-trips assistant reasoning and completed tool calls', () => {
		const message: ChatMessage = {
			id: 'assistant-1',
			role: 'assistant',
			parts: [
				{ type: 'reasoning', content: 'Checking the project' },
				{ type: 'tool-call', toolCallId: 'tool-1', toolName: 'read_file', arguments: { path: 'src/app.ts' } },
				{ type: 'tool-result', toolCallId: 'tool-1', toolName: 'read_file', result: 'contents' },
				{ type: 'text', content: 'Found it.' },
			],
		};

		const converted = uiMessagesToChatMessages([chatMessageToUiMessage(message)]);
		expect(converted).toEqual([message]);
	});

	it('round-trips image attachments', () => {
		const message: ChatMessage = {
			id: 'user-image',
			role: 'user',
			parts: [{ type: 'image', url: 'data:image/png;base64,abc', mediaType: 'image/png', name: 'screen.png' }],
		};

		expect(uiMessagesToChatMessages([chatMessageToUiMessage(message)])).toEqual([message]);
	});

	it('preserves failed tool results', () => {
		const message: ChatMessage = {
			id: 'assistant-2',
			role: 'assistant',
			parts: [
				{ type: 'tool-call', toolCallId: 'tool-2', toolName: 'lint', arguments: {} },
				{ type: 'tool-result', toolCallId: 'tool-2', toolName: 'lint', result: 'failed', isError: true },
			],
		};

		expect(uiMessagesToChatMessages([chatMessageToUiMessage(message)])).toEqual([message]);
	});
});
