/**
 * Serialization helpers for AI session persistence.
 *
 * Shared between use-ai-sessions and use-change-review hooks
 * to avoid duplicating conversion logic.
 */

import type { PendingFileChange, UIMessage } from '@shared/types';

/**
 * Derive a session label from the first user message (truncated to 50 chars).
 */
export function deriveLabel(history: UIMessage[]): string {
	const firstUserMessage = history.find((message) => message.role === 'user');
	if (!firstUserMessage) return 'New chat';

	const text = firstUserMessage.parts
		.filter((part): part is { type: 'text'; content: string } => part.type === 'text')
		.map((part) => part.content)
		.join(' ')
		.trim();

	return text.length > 50 ? text.slice(0, 50) + '...' : text || 'New chat';
}

/**
 * Convert a Map<number, string> to a JSON-safe Record<string, string>.
 */
export function snapshotsMapToRecord(snapshotsMap: Map<number, string>): Record<string, string> {
	const record: Record<string, string> = {};
	for (const [key, value] of snapshotsMap) {
		record[String(key)] = value;
	}
	return record;
}

/**
 * Convert a Record<string, string> back to a Map<number, string>.
 */
export function snapshotsRecordToMap(record: Record<string, string> | undefined): Map<number, string> {
	const map = new Map<number, string>();
	if (!record) return map;
	for (const [key, value] of Object.entries(record)) {
		const index = Number(key);
		if (Number.isFinite(index)) {
			map.set(index, value);
		}
	}
	return map;
}

/**
 * Convert a pending changes Map to a JSON-safe Record, filtering to only
 * entries that still have unresolved work (file-level 'pending' or any
 * hunk-level 'pending').
 */
export function pendingChangesMapToRecord(pendingChanges: Map<string, PendingFileChange>): Record<string, PendingFileChange> | undefined {
	const record: Record<string, PendingFileChange> = {};
	let hasEntries = false;
	for (const [key, value] of pendingChanges) {
		// Include entries that are file-level pending, or that have any
		// unresolved hunks (the file status stays 'pending' while hunks are
		// being individually resolved).
		const hasPendingHunks = value.hunkStatuses.includes('pending');
		if (value.status === 'pending' || hasPendingHunks) {
			record[key] = value;
			hasEntries = true;
		}
	}
	return hasEntries ? record : undefined;
}

/**
 * Convert a Record<string, PendingFileChange> back to a Map,
 * filtering to only entries with 'pending' status.
 */
export function pendingChangesRecordToMap(record: Record<string, PendingFileChange> | undefined): Map<string, PendingFileChange> {
	const map = new Map<string, PendingFileChange>();
	if (!record) return map;
	for (const [key, value] of Object.entries(record)) {
		if (value.status === 'pending') {
			map.set(key, value);
		}
	}
	return map;
}
