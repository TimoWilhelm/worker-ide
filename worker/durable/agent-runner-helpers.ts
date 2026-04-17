import { ExtensionManager } from '@cloudflare/think/extensions';

import { DEFAULT_AI_MODEL, getModelConfig } from '@shared/constants';

import type { FiberSnapshot } from '@shared/agent-state';
import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage, FileChange, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from '@shared/types';

interface RestorableExtensionManager {
	restore(): Promise<void>;
	list(): Array<{ name: string; description?: string; tools: unknown[] }>;
}

interface ExtensionManagerConstructor<T extends RestorableExtensionManager> {
	new (options: { loader: WorkerLoader; storage: DurableObjectStorage }): T;
}

export interface RecoveredRunParameters {
	projectId: string;
	messages: ChatMessage[];
	mode: AgentMode;
	sessionId: string;
	model: AIModelId;
	_fiberSnapshot: FiberSnapshot;
}

export function parseFiberSnapshot(snapshot: unknown): FiberSnapshot | undefined {
	if (!isRecordObject(snapshot)) {
		return undefined;
	}
	if (!Array.isArray(snapshot.workingMessages) || !Array.isArray(snapshot.chatMessages) || typeof snapshot.iteration !== 'number') {
		return undefined;
	}
	if (typeof snapshot.contextTokensUsed !== 'number' || typeof snapshot.model !== 'string' || typeof snapshot.mode !== 'string') {
		return undefined;
	}
	if (snapshot.snapshotId !== undefined && typeof snapshot.snapshotId !== 'string') {
		return undefined;
	}

	const pendingChanges = parsePendingChangesRecord(snapshot.pendingChanges);
	const toolMetadata = parseToolMetadataRecord(snapshot.toolMetadata);
	const toolErrors = parseToolErrorsRecord(snapshot.toolErrors);
	const queryChanges = parseSnapshotChanges(snapshot.queryChanges);
	if (!pendingChanges || !toolMetadata || !toolErrors || !queryChanges) {
		return undefined;
	}

	return {
		workingMessages: snapshot.workingMessages,
		chatMessages: snapshot.chatMessages,
		iteration: snapshot.iteration,
		queryChanges,
		pendingChanges,
		toolMetadata,
		toolErrors,
		contextTokensUsed: snapshot.contextTokensUsed,
		snapshotId: snapshot.snapshotId,
		model: snapshot.model,
		mode: snapshot.mode,
	};
}

export function buildRecoveredRunParameters(
	projectId: string,
	sessionId: string,
	history: ChatMessage[],
	snapshot: FiberSnapshot | undefined,
): RecoveredRunParameters | undefined {
	if (!snapshot) {
		return undefined;
	}

	return {
		projectId,
		messages: history,
		mode: normalizeRecoveredMode(snapshot.mode),
		sessionId,
		model: normalizeRecoveredModel(snapshot.model),
		_fiberSnapshot: snapshot,
	};
}

export async function restoreExtensionManager(loader: WorkerLoader, storage: DurableObjectStorage): Promise<ExtensionManager>;
export async function restoreExtensionManager<T extends RestorableExtensionManager>(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	ManagerClass: ExtensionManagerConstructor<T>,
): Promise<T>;
export async function restoreExtensionManager<T extends RestorableExtensionManager>(
	loader: WorkerLoader,
	storage: DurableObjectStorage,
	ManagerClass?: ExtensionManagerConstructor<T>,
) {
	const ResolvedManagerClass = ManagerClass ?? ExtensionManager;
	const extensionManager = new ResolvedManagerClass({ loader, storage });
	await extensionManager.restore();
	return extensionManager;
}

export function buildLoadedExtensionsSummary(
	extensionManager?: Pick<RestorableExtensionManager, 'list'>,
): Array<{ name: string; description?: string; toolCount: number }> {
	if (!extensionManager) {
		return [];
	}

	return extensionManager.list().map((extension) => ({
		name: extension.name,
		description: extension.description,
		toolCount: extension.tools.length,
	}));
}

export async function runSessionSearch<Result>(
	query: string,
	limit: number,
	search: (trimmedQuery: string, resolvedLimit: number) => Promise<Result[]> | Result[],
): Promise<Result[]> {
	const trimmedQuery = query.trim();
	if (!trimmedQuery) {
		return [];
	}

	return search(trimmedQuery, limit);
}

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return value !== undefined && value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPendingChangeStatus(value: unknown): value is PendingFileChange['status'] {
	return value === 'pending' || value === 'approved' || value === 'rejected';
}

function isPendingChangeAction(value: unknown): value is PendingFileChange['action'] {
	return value === 'create' || value === 'edit' || value === 'delete' || value === 'move';
}

function isFileChangeAction(value: unknown): value is FileChange['action'] {
	return value === 'create' || value === 'edit' || value === 'delete';
}

function parsePendingChangesRecord(value: unknown): Record<string, PendingFileChange> | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}

	const result: Record<string, PendingFileChange> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (!isRecordObject(entry)) {
			return undefined;
		}
		if (
			!isPendingChangeAction(entry.action) ||
			!isPendingChangeStatus(entry.status) ||
			typeof entry.path !== 'string' ||
			!Array.isArray(entry.hunkStatuses) ||
			typeof entry.sessionId !== 'string'
		) {
			return undefined;
		}

		result[key] = {
			path: entry.path,
			action: entry.action,
			beforeContent: typeof entry.beforeContent === 'string' ? entry.beforeContent : undefined,
			afterContent: typeof entry.afterContent === 'string' ? entry.afterContent : undefined,
			snapshotId: typeof entry.snapshotId === 'string' ? entry.snapshotId : undefined,
			status: entry.status,
			hunkStatuses: entry.hunkStatuses.filter(
				(status): status is 'pending' | 'approved' | 'rejected' => status === 'pending' || status === 'approved' || status === 'rejected',
			),
			sessionId: entry.sessionId,
		};
	}

	return result;
}

function parseToolMetadataRecord(value: unknown): Record<string, ToolMetadataInfo> | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}

	const result: Record<string, ToolMetadataInfo> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (
			!isRecordObject(entry) ||
			typeof entry.toolCallId !== 'string' ||
			typeof entry.toolName !== 'string' ||
			typeof entry.title !== 'string'
		) {
			return undefined;
		}
		result[key] = {
			toolCallId: entry.toolCallId,
			toolName: entry.toolName,
			title: entry.title,
			metadata: isRecordObject(entry.metadata) ? entry.metadata : {},
		};
	}

	return result;
}

function parseToolErrorsRecord(value: unknown): Record<string, ToolErrorInfo> | undefined {
	if (!isRecordObject(value)) {
		return undefined;
	}

	const result: Record<string, ToolErrorInfo> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (
			!isRecordObject(entry) ||
			typeof entry.toolCallId !== 'string' ||
			typeof entry.toolName !== 'string' ||
			typeof entry.errorCode !== 'string' ||
			typeof entry.errorMessage !== 'string'
		) {
			return undefined;
		}
		result[key] = {
			toolCallId: entry.toolCallId,
			toolName: entry.toolName,
			errorCode: entry.errorCode,
			errorMessage: entry.errorMessage,
		};
	}

	return result;
}

function parseSnapshotChanges(value: unknown): FileChange[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}

	const result: FileChange[] = [];
	for (const entry of value) {
		if (
			!isRecordObject(entry) ||
			typeof entry.path !== 'string' ||
			!isFileChangeAction(entry.action) ||
			typeof entry.isBinary !== 'boolean'
		) {
			return undefined;
		}
		result.push({
			path: entry.path,
			action: entry.action,
			beforeContent: typeof entry.beforeContent === 'string' ? entry.beforeContent : undefined,
			afterContent: typeof entry.afterContent === 'string' ? entry.afterContent : undefined,
			isBinary: entry.isBinary,
		});
	}

	return result;
}

function isAiModelId(value: unknown): value is AIModelId {
	return typeof value === 'string' && !!getModelConfig(value);
}

function normalizeRecoveredMode(mode: string): AgentMode {
	return mode === 'plan' || mode === 'ask' ? mode : 'code';
}

function normalizeRecoveredModel(model: string): AIModelId {
	return isAiModelId(model) ? model : DEFAULT_AI_MODEL;
}
