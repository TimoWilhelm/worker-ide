import { readSessionMessageMetadata, readSessionMetadata, replaceSessionMessageMetadata, upsertSessionMetadata } from './db';
import { applyPersistedMessageMetadata, serializePersistedMessageMetadata } from './session-history';
import { chatMessageToSessionMessage, sessionMessagesToChatMessages } from '../services/ai-agent/session-messages';

import type { AgentDatabase, SessionMetadataRow } from './db';
import type { AgentSessionStatus, AiSession, ChatMessage, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';
import type { SessionInfo, SessionMessage } from 'agents/experimental/memory/session';

const AGENT_SESSION_STATUSES: ReadonlySet<string> = new Set(['running', 'completed', 'error', 'aborted']);

function isAgentSessionStatus(value: unknown): value is AgentSessionStatus {
	return typeof value === 'string' && AGENT_SESSION_STATUSES.has(value);
}

export interface SessionMetadataState {
	titleGenerated?: boolean;
	contextTokensUsed?: number;
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	status?: AgentSessionStatus;
	errorMessage?: string;
	stopRequested?: boolean;
}

export interface SessionHistoryStore {
	get(sessionId: string): SessionInfo | null | undefined;
	getHistory(sessionId: string): SessionMessage[];
	clearMessages(sessionId: string): void;
	appendAll(sessionId: string, messages: SessionMessage[]): Promise<unknown>;
}

function parseSessionMetadata(row: SessionMetadataRow | undefined): SessionMetadataState {
	if (!row) {
		return {};
	}

	return {
		titleGenerated: row.titleGenerated === 1,
		contextTokensUsed: row.contextTokensUsed ?? undefined,
		toolMetadata: row.toolMetadata ? JSON.parse(row.toolMetadata) : undefined,
		toolErrors: row.toolErrors ? JSON.parse(row.toolErrors) : undefined,
		status: isAgentSessionStatus(row.status) ? row.status : undefined,
		errorMessage: row.errorMessage ?? undefined,
		stopRequested: row.stopRequested === 1,
	};
}

function buildAiSession(sessionInfo: SessionInfo, history: ChatMessage[], metadata: SessionMetadataState): AiSession {
	return {
		id: sessionInfo.id,
		title: sessionInfo.name,
		titleGenerated: metadata.titleGenerated,
		createdAt: Date.parse(sessionInfo.created_at),
		history,
		contextTokensUsed: metadata.contextTokensUsed,
		toolMetadata: metadata.toolMetadata,
		toolErrors: metadata.toolErrors,
		status: metadata.status,
		errorMessage: metadata.errorMessage,
		stopRequested: metadata.stopRequested,
	};
}

export class AgentSessionStore {
	constructor(
		private database: AgentDatabase,
		private sessionHistoryStore: SessionHistoryStore,
	) {}

	getMetadata(sessionId: string): SessionMetadataState {
		return parseSessionMetadata(readSessionMetadata(this.database, sessionId));
	}

	read(sessionId: string): AiSession | undefined {
		const sessionInfo = this.sessionHistoryStore.get(sessionId);
		if (!sessionInfo) {
			return undefined;
		}

		const metadata = this.getMetadata(sessionId);
		const sessionHistory = sessionMessagesToChatMessages(this.sessionHistoryStore.getHistory(sessionId));
		const persistedMessageMetadata = readSessionMessageMetadata(this.database, sessionId);
		const history = applyPersistedMessageMetadata(sessionHistory, persistedMessageMetadata);
		return buildAiSession(sessionInfo, history, metadata);
	}

	getHistory(sessionId: string): ChatMessage[] {
		return this.read(sessionId)?.history ?? [];
	}

	writeMetadata(sessionId: string, patch: Partial<SessionMetadataState>): void {
		const existing = this.getMetadata(sessionId);
		const toolMetadata = patch.toolMetadata ?? existing.toolMetadata;
		const toolErrors = patch.toolErrors ?? existing.toolErrors;

		upsertSessionMetadata(this.database, {
			id: sessionId,
			titleGenerated: (patch.titleGenerated ?? existing.titleGenerated) ? 1 : 0,
			contextTokensUsed: patch.contextTokensUsed ?? existing.contextTokensUsed,
			toolMetadata: toolMetadata ? JSON.stringify(toolMetadata) : undefined,
			toolErrors: toolErrors ? JSON.stringify(toolErrors) : undefined,
			status: patch.status ?? existing.status,
			errorMessage: patch.errorMessage ?? existing.errorMessage,
			stopRequested: (patch.stopRequested ?? existing.stopRequested) ? 1 : 0,
		});
	}

	async replaceHistory(sessionId: string, history: ChatMessage[]): Promise<void> {
		this.sessionHistoryStore.clearMessages(sessionId);
		await this.sessionHistoryStore.appendAll(
			sessionId,
			history.map((message) => chatMessageToSessionMessage(message)),
		);
		replaceSessionMessageMetadata(this.database, sessionId, serializePersistedMessageMetadata(sessionId, history));
	}

	async persistHistory(sessionId: string, history: ChatMessage[], stopRequested?: boolean): Promise<void> {
		await this.replaceHistory(sessionId, history);
		this.writeMetadata(sessionId, { stopRequested });
	}
}
