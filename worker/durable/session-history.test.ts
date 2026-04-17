import { describe, expect, it } from 'vitest';

import {
	applyLegacySessionMessageMetadata,
	clearSnapshotFromMessages,
	getCommittedMessages,
	getLastCommittedRequestConfig,
	getQueuedMessages,
	mergeQueuedMessages,
	promoteNextQueuedMessage,
	setSnapshotOnLastCommittedUserMessage,
} from './session-history';

import type { ChatMessage } from '@shared/types';

function createUserMessage(
	id: string,
	content: string,
	state: 'queued' | 'committed',
	mode = 'code',
	model = '@cf/moonshotai/kimi-k2.5',
): ChatMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', content }],
		createdAt: 1,
		metadata: {
			request: {
				state,
				mode,
				model,
			},
		},
	};
}

describe('session-history', () => {
	it('separates committed and queued messages', () => {
		const messages = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];

		expect(getCommittedMessages(messages).map((message) => message.id)).toEqual(['m1']);
		expect(getQueuedMessages(messages).map((message) => message.id)).toEqual(['m2']);
	});

	it('promotes only the next queued message', () => {
		const messages = [
			createUserMessage('m1', 'first', 'committed'),
			createUserMessage('m2', 'second', 'queued', 'plan', '@cf/google/gemma-4-26b-a4b-it'),
			createUserMessage('m3', 'third', 'queued', 'ask'),
		];

		const { history, promotedMessage } = promoteNextQueuedMessage(messages);

		expect(promotedMessage?.id).toBe('m2');
		expect(history[1]?.metadata?.request?.state).toBe('committed');
		expect(history[2]?.metadata?.request?.state).toBe('queued');
	});

	it('merges queued tail messages when persisting committed history', () => {
		const existingHistory = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];
		const committedHistory = [createUserMessage('m1', 'first', 'committed')];

		expect(mergeQueuedMessages(committedHistory, existingHistory).map((message) => message.id)).toEqual(['m1', 'm2']);
	});

	it('applies legacy snapshot and mode metadata onto messages', () => {
		const history = [createUserMessage('m1', 'first', 'committed')];

		const hydrated = applyLegacySessionMessageMetadata(history, { 0: 'snapshot-1' }, { 0: 'plan' });

		expect(hydrated[0]?.metadata?.snapshotId).toBe('snapshot-1');
		expect(hydrated[0]?.metadata?.request?.mode).toBe('plan');
	});

	it('updates snapshot metadata on the last committed user message', () => {
		const messages = [createUserMessage('m1', 'first', 'committed'), createUserMessage('m2', 'second', 'queued')];

		const withSnapshot = setSnapshotOnLastCommittedUserMessage(messages, 'snapshot-1');
		expect(withSnapshot[0]?.metadata?.snapshotId).toBe('snapshot-1');

		const cleared = clearSnapshotFromMessages(withSnapshot, 'snapshot-1');
		expect(cleared[0]?.metadata?.snapshotId).toBeUndefined();
	});

	it('uses the last committed request config for the next run', () => {
		const messages = [
			createUserMessage('m1', 'first', 'committed', 'ask', '@cf/google/gemma-4-26b-a4b-it'),
			createUserMessage('m2', 'second', 'queued', 'plan'),
		];

		expect(getLastCommittedRequestConfig(messages)).toEqual({
			mode: 'ask',
			model: '@cf/google/gemma-4-26b-a4b-it',
		});
	});
});
