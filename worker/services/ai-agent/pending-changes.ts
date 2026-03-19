/**
 * Server-Side Pending Changes Accumulation.
 *
 * Mirrors the deduplication logic from the client-side addPendingChange
 * (store.ts) so the server builds the same net result without relying
 * on client-side saves.
 *
 * Key dedup rules:
 * - create -> delete = net no-op (remove from map)
 * - create -> edit   = still a create (with updated content)
 * - delete -> create = effectively an edit
 * - All cases: if net content is identical to original, remove entry
 */

import type { PendingFileChange } from '@shared/types';

/**
 * Accumulate a file_changed event into a pending changes map.
 */
export function accumulatePendingChange(
	pendingChanges: Map<string, PendingFileChange>,
	change: Omit<PendingFileChange, 'status' | 'hunkStatuses'>,
): void {
	const existing = pendingChanges.get(change.path);

	if (!existing) {
		// Skip if content is identical (no actual change)
		if (change.action !== 'move' && change.beforeContent !== undefined && change.beforeContent === change.afterContent) {
			return;
		}
		pendingChanges.set(change.path, { ...change, status: 'pending', hunkStatuses: [] });
		return;
	}

	// Keep the first beforeContent and existing snapshotId for dedup
	const beforeContent = existing.beforeContent;
	const snapshotId = existing.snapshotId ?? change.snapshotId;
	const originalAction = existing.action;
	const newAction = change.action;

	// create -> delete = net no-op
	if (originalAction === 'create' && newAction === 'delete') {
		pendingChanges.delete(change.path);
		return;
	}

	// create -> edit = still a create (with updated content)
	if (originalAction === 'create' && newAction === 'edit') {
		if (beforeContent !== undefined && beforeContent === change.afterContent) {
			pendingChanges.delete(change.path);
			return;
		}
		pendingChanges.set(change.path, { ...change, action: 'create', beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
		return;
	}

	// delete -> create = effectively an edit
	if (originalAction === 'delete' && newAction === 'create') {
		if (beforeContent !== undefined && beforeContent === change.afterContent) {
			pendingChanges.delete(change.path);
			return;
		}
		pendingChanges.set(change.path, { ...change, action: 'edit', beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
		return;
	}

	// All other cases: keep original beforeContent, use new action & afterContent
	if (newAction !== 'move' && beforeContent !== undefined && beforeContent === change.afterContent) {
		pendingChanges.delete(change.path);
		return;
	}
	pendingChanges.set(change.path, { ...change, beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
}

/**
 * Convert a pending changes Map to a JSON-safe Record, filtering to only
 * entries with 'pending' status.
 */
export function pendingChangesMapToRecord(pendingChanges: Map<string, PendingFileChange>): Record<string, PendingFileChange> | undefined {
	const record: Record<string, PendingFileChange> = {};
	let hasEntries = false;
	for (const [key, value] of pendingChanges) {
		if (value.status === 'pending') {
			record[key] = value;
			hasEntries = true;
		}
	}
	return hasEntries ? record : undefined;
}
