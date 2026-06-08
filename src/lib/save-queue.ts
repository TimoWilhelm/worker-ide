const SAVE_QUEUE_STORAGE_KEY = 'worker-ide-save-queue:v1';

export interface QueuedSave {
	projectId: string;
	path: string;
	content: string;
	createdAt: number;
	updatedAt: number;
	attemptCount: number;
	operationId: string;
}

interface FlushQueuedSavesOptions {
	projectId?: string;
	save: (entry: QueuedSave) => Promise<void>;
	onSuccess?: (entry: QueuedSave) => void;
}

const listeners = new Set<() => void>();
const flushingProjects = new Set<string>();

function getStorage(): Storage | undefined {
	try {
		return globalThis.localStorage;
	} catch {
		return undefined;
	}
}

function queueKey(projectId: string, path: string): string {
	return `${projectId}:${path}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== undefined && Boolean(value) && !Array.isArray(value);
}

function isQueuedSave(value: unknown): value is QueuedSave {
	if (!isRecord(value)) return false;
	return (
		typeof value.projectId === 'string' &&
		typeof value.path === 'string' &&
		typeof value.content === 'string' &&
		typeof value.createdAt === 'number' &&
		typeof value.updatedAt === 'number' &&
		typeof value.attemptCount === 'number' &&
		typeof value.operationId === 'string'
	);
}

function readQueue(): QueuedSave[] {
	const storage = getStorage();
	if (!storage) return [];

	try {
		const raw = storage.getItem(SAVE_QUEUE_STORAGE_KEY);
		if (!raw) return [];

		const parsed: unknown = JSON.parse(raw);
		if (!Array.isArray(parsed)) {
			storage.removeItem(SAVE_QUEUE_STORAGE_KEY);
			return [];
		}

		return parsed.filter((entry) => isQueuedSave(entry));
	} catch {
		storage.removeItem(SAVE_QUEUE_STORAGE_KEY);
		return [];
	}
}

function writeQueue(queue: QueuedSave[]): void {
	const storage = getStorage();
	if (!storage) return;

	try {
		if (queue.length === 0) {
			storage.removeItem(SAVE_QUEUE_STORAGE_KEY);
		} else {
			storage.setItem(SAVE_QUEUE_STORAGE_KEY, JSON.stringify(queue));
		}
	} catch {
		// Storage unavailable/full: keep current editor state, but do not throw.
	}
}

function notifyListeners(): void {
	for (const listener of listeners) {
		listener();
	}
}

export function createSaveOperationId(): string {
	return globalThis.crypto?.randomUUID?.() ?? `save-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function subscribeSaveQueue(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function listQueuedSaves(projectId?: string): QueuedSave[] {
	const queue = readQueue();
	return projectId ? queue.filter((entry) => entry.projectId === projectId) : queue;
}

export function enqueueSave(entry: Omit<QueuedSave, 'createdAt' | 'updatedAt' | 'attemptCount'> & Partial<QueuedSave>): QueuedSave {
	const now = Date.now();
	const queue = readQueue();
	const key = queueKey(entry.projectId, entry.path);
	const existingIndex = queue.findIndex((item) => queueKey(item.projectId, item.path) === key);
	const existing = existingIndex === -1 ? undefined : queue[existingIndex];
	const next: QueuedSave = {
		projectId: entry.projectId,
		path: entry.path,
		content: entry.content,
		createdAt: existing?.createdAt ?? entry.createdAt ?? now,
		updatedAt: now,
		attemptCount: existing?.attemptCount ?? entry.attemptCount ?? 0,
		operationId: entry.operationId,
	};

	if (existingIndex === -1) {
		queue.push(next);
	} else {
		queue[existingIndex] = next;
	}

	writeQueue(queue);
	notifyListeners();
	return next;
}

export function removeQueuedSave(projectId: string, path: string, operationId: string): void {
	const queue = readQueue();
	const nextQueue = queue.filter((entry) => entry.projectId !== projectId || entry.path !== path || entry.operationId !== operationId);
	if (nextQueue.length === queue.length) return;

	writeQueue(nextQueue);
	notifyListeners();
}

export function removeQueuedSaveForPath(projectId: string, path: string): void {
	const queue = readQueue();
	const nextQueue = queue.filter((entry) => entry.projectId !== projectId || entry.path !== path);
	if (nextQueue.length === queue.length) return;

	writeQueue(nextQueue);
	notifyListeners();
}

function incrementAttemptCount(entry: QueuedSave): void {
	const queue = readQueue();
	const nextQueue = queue.map((item) => {
		if (item.projectId === entry.projectId && item.path === entry.path && item.operationId === entry.operationId) {
			return { ...item, attemptCount: item.attemptCount + 1, updatedAt: Date.now() };
		}
		return item;
	});
	writeQueue(nextQueue);
	notifyListeners();
}

export async function flushQueuedSaves({ projectId, save, onSuccess }: FlushQueuedSavesOptions): Promise<void> {
	const flushKey = projectId ?? '*';
	if (flushingProjects.has(flushKey)) return;

	flushingProjects.add(flushKey);
	try {
		const entries = listQueuedSaves(projectId).toSorted((first, second) => first.updatedAt - second.updatedAt);
		for (const entry of entries) {
			try {
				await save(entry);
				removeQueuedSave(entry.projectId, entry.path, entry.operationId);
				onSuccess?.(entry);
			} catch {
				incrementAttemptCount(entry);
			}
		}
	} finally {
		flushingProjects.delete(flushKey);
	}
}

export function getQueuedSaveCount(projectId?: string): number {
	return listQueuedSaves(projectId).length;
}
