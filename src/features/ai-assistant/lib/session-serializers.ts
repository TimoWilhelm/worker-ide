/**
 * Serialization helpers for AI session persistence.
 *
 * Shared between use-ai-sessions and use-change-review hooks
 * to avoid duplicating conversion logic.
 */

import type { AgentMode, PendingFileChange } from '@shared/types';

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
 * Convert a Record<string, AgentMode> back to a Map<number, AgentMode>.
 */
export function messageModesRecordToMap(record: Record<string, AgentMode> | undefined): Map<number, AgentMode> {
	const map = new Map<number, AgentMode>();
	if (!record) return map;
	for (const [key, value] of Object.entries(record)) {
		const index = Number(key);
		if (Number.isFinite(index) && (value === 'code' || value === 'plan' || value === 'ask')) {
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
