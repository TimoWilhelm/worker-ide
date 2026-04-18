import { DEFAULT_AI_MODEL, getModelConfig } from '@shared/constants';

import type { SessionMessageMetadataInsert, SessionMessageMetadataRow } from './db';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage } from '@shared/types';

function isAgentMode(value: unknown): value is AgentMode {
	return value === 'code' || value === 'plan' || value === 'ask';
}

function isRequestState(value: unknown): value is 'queued' | 'committed' {
	return value === 'queued' || value === 'committed';
}

function isAiModelId(value: unknown): value is AIModelId {
	return typeof value === 'string' && !!getModelConfig(value);
}

function isQueuedMessage(message: ChatMessage): boolean {
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

export function applyPersistedMessageMetadata(history: ChatMessage[], rows: SessionMessageMetadataRow[]): ChatMessage[] {
	if (rows.length === 0) {
		return history;
	}

	const metadataByMessageId = new Map(rows.map((row) => [row.messageId, row]));
	return history.map((message) => {
		const row = metadataByMessageId.get(message.id);
		if (!row) {
			return message;
		}

		const requestState = isRequestState(row.requestState) ? row.requestState : message.metadata?.request?.state;
		const requestMode = isAgentMode(row.requestMode) ? row.requestMode : message.metadata?.request?.mode;
		const requestModel = isAiModelId(row.requestModel) ? row.requestModel : message.metadata?.request?.model;
		const request =
			message.role === 'user' && (requestState || requestMode || requestModel)
				? {
						state: requestState ?? 'committed',
						mode: requestMode,
						model: requestModel,
					}
				: message.metadata?.request;

		return {
			...message,
			metadata: {
				...message.metadata,
				request,
				snapshotId: row.snapshotId ?? message.metadata?.snapshotId,
			},
		};
	});
}

export function serializePersistedMessageMetadata(sessionId: string, history: ChatMessage[]): SessionMessageMetadataInsert[] {
	const rows: SessionMessageMetadataInsert[] = [];
	for (const message of history) {
		const request = message.role === 'user' ? message.metadata?.request : undefined;
		const snapshotId = message.metadata?.snapshotId;
		if (!request && !snapshotId) {
			continue;
		}

		rows.push({
			sessionId,
			messageId: message.id,
			requestMode: request?.mode,
			requestModel: request?.model,
			requestState: request?.state,
			snapshotId,
		});
	}

	return rows;
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
