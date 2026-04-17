import { DEFAULT_AI_MODEL } from '@shared/constants';

import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage } from '@shared/types';

export function isQueuedMessage(message: ChatMessage): boolean {
	return message.role === 'user' && message.metadata?.request?.state === 'queued';
}

export function getQueuedMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => isQueuedMessage(message));
}

export function getCommittedMessages(messages: ChatMessage[]): ChatMessage[] {
	return messages.filter((message) => !isQueuedMessage(message));
}

export function getLastCommittedRequestConfig(messages: ChatMessage[]): { mode: AgentMode; model: AIModelId } {
	for (let index = messages.length - 1; index >= 0; index--) {
		const request = messages[index]?.metadata?.request;
		if (messages[index]?.role === 'user' && request?.state === 'committed') {
			return {
				mode: request.mode ?? 'code',
				model: request.model ?? DEFAULT_AI_MODEL,
			};
		}
	}

	return { mode: 'code', model: DEFAULT_AI_MODEL };
}

export function promoteNextQueuedMessage(messages: ChatMessage[]): { history: ChatMessage[]; promotedMessage: ChatMessage | undefined } {
	const queuedIndex = messages.findIndex((message) => isQueuedMessage(message));
	if (queuedIndex === -1) {
		return { history: messages, promotedMessage: undefined };
	}

	const queuedMessage = messages[queuedIndex];
	const promotedMessage: ChatMessage = {
		...queuedMessage,
		metadata: {
			...queuedMessage.metadata,
			request: {
				...queuedMessage.metadata?.request,
				state: 'committed',
			},
		},
	};

	const history = [...messages];
	history[queuedIndex] = promotedMessage;
	return { history, promotedMessage };
}

export function mergeQueuedMessages(committedHistory: ChatMessage[], existingHistory: ChatMessage[]): ChatMessage[] {
	const existingQueuedMessages = existingHistory.filter(
		(message) => isQueuedMessage(message) && !committedHistory.some((candidate) => candidate.id === message.id),
	);
	if (existingQueuedMessages.length === 0) {
		return committedHistory;
	}
	return [...committedHistory, ...existingQueuedMessages];
}

export function applyLegacySessionMessageMetadata(
	history: ChatMessage[],
	messageSnapshots?: Record<string, string>,
	messageModes?: Record<string, AgentMode>,
): ChatMessage[] {
	if (!messageSnapshots && !messageModes) {
		return history;
	}

	return history.map((message, index) => {
		const snapshotId = messageSnapshots?.[String(index)];
		const mode = messageModes?.[String(index)];
		if (!snapshotId && !mode) {
			return message;
		}

		return {
			...message,
			metadata: {
				...message.metadata,
				request:
					message.role === 'user'
						? {
								...message.metadata?.request,
								mode: mode ?? message.metadata?.request?.mode,
								state: message.metadata?.request?.state ?? 'committed',
							}
						: message.metadata?.request,
				snapshotId: snapshotId ?? message.metadata?.snapshotId,
			},
		};
	});
}

export function setSnapshotOnLastCommittedUserMessage(messages: ChatMessage[], snapshotId: string): ChatMessage[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role !== 'user' || message.metadata?.request?.state === 'queued') {
			continue;
		}

		const updated = [...messages];
		updated[index] = {
			...message,
			metadata: {
				...message.metadata,
				snapshotId,
			},
		};
		return updated;
	}

	return messages;
}

export function clearSnapshotFromMessages(messages: ChatMessage[], snapshotId: string): ChatMessage[] {
	let changed = false;
	const updated = messages.map((message) => {
		if (message.metadata?.snapshotId !== snapshotId) {
			return message;
		}

		changed = true;
		return {
			...message,
			metadata: {
				...message.metadata,
				snapshotId: undefined,
			},
		};
	});

	return changed ? updated : messages;
}
