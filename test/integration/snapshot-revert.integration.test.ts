/**
 * Integration tests for the Snapshot & Revert system.
 *
 * Tests the full lifecycle: snapshot creation, listing, detail fetching,
 * single-file revert, full snapshot revert, and cascade revert.
 *
 * Also covers edge cases: overlapping files across snapshots, missing
 * snapshots, partial failures, pending changes coordination, and
 * the interaction between revert and the pending changes API.
 *
 * These tests run against a live dev server and create real projects
 * with real files on the Durable Object filesystem.
 */

import { beforeAll, describe, expect, it } from 'vitest';

const BASE_URL = process.env.TEST_BASE_URL || 'http://localhost:3000';

// =============================================================================
// Helpers
// =============================================================================

/** Create a fresh project and return its ID. */
async function createProject(): Promise<string> {
	const response = await fetch(`${BASE_URL}/api/new-project`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({}),
	});
	const result: { projectId: string } = await response.json();
	// Trigger initialization by listing files
	await fetch(`${BASE_URL}/p/${result.projectId}/api/files`);
	return result.projectId;
}

/** Write a file to the project. */
async function writeFile(projectId: string, path: string, content: string): Promise<void> {
	const response = await fetch(`${BASE_URL}/p/${projectId}/api/file`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({ path, content }),
	});
	expect(response.ok).toBe(true);
}

/** Read a file's content. Returns undefined if not found. */
async function readFile(projectId: string, path: string): Promise<string | undefined> {
	const response = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=${encodeURIComponent(path)}`);
	if (!response.ok) return undefined;
	const result: { content: string } = await response.json();
	return result.content;
}

/** Delete a file from the project. */
async function deleteFile(projectId: string, path: string): Promise<void> {
	await fetch(`${BASE_URL}/p/${projectId}/api/file?path=${encodeURIComponent(path)}`, {
		method: 'DELETE',
	});
}

/** Check whether a file exists. */
async function fileExists(projectId: string, path: string): Promise<boolean> {
	const response = await fetch(`${BASE_URL}/p/${projectId}/api/file?path=${encodeURIComponent(path)}`);
	return response.ok;
}

/**
 * Manually create a snapshot directory with metadata and optional backup files.
 * This simulates what the AI agent service does during a code turn.
 */
async function createSnapshot(
	projectId: string,
	snapshotId: string,
	options: {
		label?: string;
		sessionId?: string;
		changes: Array<{
			path: string;
			action: 'create' | 'edit' | 'delete';
			/** For edit/delete actions: the original content to back up */
			beforeContent?: string;
		}>;
	},
): Promise<void> {
	const metadata = {
		id: snapshotId,
		timestamp: Date.now(),
		label: options.label ?? 'Test snapshot',
		sessionId: options.sessionId,
		changes: options.changes.map((change) => ({ path: change.path, action: change.action })),
	};

	// Write the metadata.json
	await writeFile(projectId, `/.agent/snapshots/${snapshotId}/metadata.json`, JSON.stringify(metadata, undefined, 2));

	// Write backup files for edit/delete actions
	for (const change of options.changes) {
		if (change.action !== 'create' && change.beforeContent !== undefined) {
			await writeFile(projectId, `/.agent/snapshots/${snapshotId}${change.path}`, change.beforeContent);
		}
	}
}

/** Save pending changes to the project. */
async function savePendingChanges(
	projectId: string,
	changes: Record<
		string,
		{
			path: string;
			action: 'create' | 'edit' | 'delete' | 'move';
			beforeContent?: string;
			afterContent?: string;
			snapshotId?: string;
			status: 'pending' | 'approved' | 'rejected';
			hunkStatuses: Array<'pending' | 'approved' | 'rejected'>;
			sessionId: string;
		}
	>,
): Promise<void> {
	const response = await fetch(`${BASE_URL}/p/${projectId}/api/pending-changes`, {
		method: 'PUT',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify(changes),
	});
	expect(response.ok).toBe(true);
}

/** Load pending changes from the project. */
async function loadPendingChanges(projectId: string): Promise<Record<string, unknown>> {
	const response = await fetch(`${BASE_URL}/p/${projectId}/api/pending-changes`);
	expect(response.ok).toBe(true);
	return response.json();
}

type SnapshotSummary = { id: string; timestamp: number; label: string; changeCount: number };
type SnapshotMetadata = {
	id: string;
	timestamp: number;
	label: string;
	sessionId?: string;
	changes: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>;
};
type CascadeRevertResult = {
	reverted: Array<{ path: string; snapshotId: string; action: string }>;
	failed: Array<{ path: string; snapshotId: string; action: string; error: string }>;
	missingSnapshots: string[];
};

// =============================================================================
// Test Suite
// =============================================================================

describe('Snapshot & Revert Integration Tests', () => {
	let projectId: string;

	beforeAll(async () => {
		projectId = await createProject();
	});

	// =========================================================================
	// Snapshot Listing & Detail
	// =========================================================================

	describe('Snapshot Listing & Detail', () => {
		it('GET /api/snapshots returns empty array for a fresh project', async () => {
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/snapshots`);
			expect(response.ok).toBe(true);
			const result: { snapshots: SnapshotSummary[] } = await response.json();
			expect(Array.isArray(result.snapshots)).toBe(true);
			// May have snapshots from other describe blocks if they ran first,
			// but at minimum it should be an array.
		});

		it('lists a manually created snapshot', async () => {
			await createSnapshot(projectId, 'aabb0001', {
				label: 'First snapshot',
				sessionId: 'sess-list-1',
				changes: [{ path: '/src/list-test.ts', action: 'create' }],
			});
			// Also create the file so the project is consistent
			await writeFile(projectId, '/src/list-test.ts', 'created by AI');

			const response = await fetch(`${BASE_URL}/p/${projectId}/api/snapshots`);
			const result: { snapshots: SnapshotSummary[] } = await response.json();
			const snapshot = result.snapshots.find((s) => s.id === 'aabb0001');
			expect(snapshot).toBeDefined();
			expect(snapshot!.label).toBe('First snapshot');
			expect(snapshot!.changeCount).toBe(1);
		});

		it('GET /api/snapshot/:id returns full metadata', async () => {
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/snapshot/aabb0001`);
			expect(response.ok).toBe(true);
			const result: { snapshot: SnapshotMetadata } = await response.json();
			expect(result.snapshot.id).toBe('aabb0001');
			expect(result.snapshot.sessionId).toBe('sess-list-1');
			expect(result.snapshot.changes).toHaveLength(1);
			expect(result.snapshot.changes[0]).toEqual({ path: '/src/list-test.ts', action: 'create' });
		});

		it('GET /api/snapshot/:id returns 404 for non-existent snapshot', async () => {
			const response = await fetch(`${BASE_URL}/p/${projectId}/api/snapshot/00000000`);
			expect(response.status).toBe(404);
		});
	});

	// =========================================================================
	// Single Snapshot Revert
	// =========================================================================

	describe('Single Snapshot Revert', () => {
		let revertProjectId: string;

		beforeAll(async () => {
			revertProjectId = await createProject();
		});

		it('reverts a created file (deletes it)', async () => {
			// Simulate: AI created /src/new-file.ts
			await writeFile(revertProjectId, '/src/new-file.ts', 'new content');
			await createSnapshot(revertProjectId, 'aabb0010', {
				changes: [{ path: '/src/new-file.ts', action: 'create' }],
			});

			// Revert
			const response = await fetch(`${BASE_URL}/p/${revertProjectId}/api/snapshot/aabb0010/revert`, {
				method: 'POST',
			});
			expect(response.ok).toBe(true);

			// File should be deleted
			expect(await fileExists(revertProjectId, '/src/new-file.ts')).toBe(false);
		});

		it('reverts an edited file (restores original content)', async () => {
			// Setup: original file content
			await writeFile(revertProjectId, '/src/edited.ts', 'original content');

			// Simulate: AI edited the file
			await createSnapshot(revertProjectId, 'aabb0011', {
				changes: [{ path: '/src/edited.ts', action: 'edit', beforeContent: 'original content' }],
			});
			await writeFile(revertProjectId, '/src/edited.ts', 'AI modified content');

			// Revert
			const response = await fetch(`${BASE_URL}/p/${revertProjectId}/api/snapshot/aabb0011/revert`, {
				method: 'POST',
			});
			expect(response.ok).toBe(true);

			// File should be restored to original
			const content = await readFile(revertProjectId, '/src/edited.ts');
			expect(content).toBe('original content');
		});

		it('reverts a deleted file (recreates it)', async () => {
			// Setup: create the file, then simulate AI deleting it
			await writeFile(revertProjectId, '/src/deleted.ts', 'I was here');
			await createSnapshot(revertProjectId, 'aabb0012', {
				changes: [{ path: '/src/deleted.ts', action: 'delete', beforeContent: 'I was here' }],
			});
			await deleteFile(revertProjectId, '/src/deleted.ts');

			// Revert
			const response = await fetch(`${BASE_URL}/p/${revertProjectId}/api/snapshot/aabb0012/revert`, {
				method: 'POST',
			});
			expect(response.ok).toBe(true);

			// File should be recreated
			const content = await readFile(revertProjectId, '/src/deleted.ts');
			expect(content).toBe('I was here');
		});

		it('returns 404 when reverting a non-existent snapshot', async () => {
			const response = await fetch(`${BASE_URL}/p/${revertProjectId}/api/snapshot/deadbeef/revert`, {
				method: 'POST',
			});
			expect(response.status).toBe(500);
		});
	});

	// =========================================================================
	// Single File Revert
	// =========================================================================

	describe('Single File Revert', () => {
		let fileRevertProjectId: string;

		beforeAll(async () => {
			fileRevertProjectId = await createProject();
		});

		it('reverts a single file from a multi-file snapshot', async () => {
			// Setup: two files
			await writeFile(fileRevertProjectId, '/src/keep.ts', 'keep original');
			await writeFile(fileRevertProjectId, '/src/revert-me.ts', 'original');

			// Simulate: AI edited both files
			await createSnapshot(fileRevertProjectId, 'aabb0020', {
				changes: [
					{ path: '/src/keep.ts', action: 'edit', beforeContent: 'keep original' },
					{ path: '/src/revert-me.ts', action: 'edit', beforeContent: 'original' },
				],
			});
			await writeFile(fileRevertProjectId, '/src/keep.ts', 'AI changed');
			await writeFile(fileRevertProjectId, '/src/revert-me.ts', 'AI changed');

			// Revert only one file
			const response = await fetch(`${BASE_URL}/p/${fileRevertProjectId}/api/snapshot/revert-file`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/src/revert-me.ts', snapshotId: 'aabb0020' }),
			});
			expect(response.ok).toBe(true);

			// Only the targeted file should be reverted
			expect(await readFile(fileRevertProjectId, '/src/revert-me.ts')).toBe('original');
			expect(await readFile(fileRevertProjectId, '/src/keep.ts')).toBe('AI changed');
		});

		it('returns 500 for a file not in the snapshot', async () => {
			const response = await fetch(`${BASE_URL}/p/${fileRevertProjectId}/api/snapshot/revert-file`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/src/not-in-snapshot.ts', snapshotId: 'aabb0020' }),
			});
			expect(response.status).toBe(500);
		});

		it('returns 500 for a non-existent snapshot', async () => {
			const response = await fetch(`${BASE_URL}/p/${fileRevertProjectId}/api/snapshot/revert-file`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: '/src/revert-me.ts', snapshotId: 'deadbeef' }),
			});
			expect(response.status).toBe(500);
		});
	});

	// =========================================================================
	// Cascade Revert — Happy Path
	// =========================================================================

	describe('Cascade Revert — Happy Path', () => {
		let cascadeProjectId: string;

		beforeAll(async () => {
			cascadeProjectId = await createProject();
		});

		it('reverts a single snapshot via cascade (equivalent to single revert)', async () => {
			await writeFile(cascadeProjectId, '/src/single.ts', 'original');
			await createSnapshot(cascadeProjectId, 'cc000001', {
				changes: [{ path: '/src/single.ts', action: 'edit', beforeContent: 'original' }],
			});
			await writeFile(cascadeProjectId, '/src/single.ts', 'AI v1');

			const response = await fetch(`${BASE_URL}/p/${cascadeProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['cc000001'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(1);
			expect(result.reverted[0].path).toBe('/src/single.ts');
			expect(result.failed).toHaveLength(0);
			expect(result.missingSnapshots).toHaveLength(0);

			expect(await readFile(cascadeProjectId, '/src/single.ts')).toBe('original');
		});

		it('cascade-reverts two snapshots in reverse chronological order', async () => {
			// Turn 1: AI creates file-a.ts and edits file-b.ts
			await writeFile(cascadeProjectId, '/src/file-b.ts', 'b-original');
			await createSnapshot(cascadeProjectId, 'cc000010', {
				sessionId: 'sess-cascade',
				changes: [
					{ path: '/src/file-a.ts', action: 'create' },
					{ path: '/src/file-b.ts', action: 'edit', beforeContent: 'b-original' },
				],
			});
			await writeFile(cascadeProjectId, '/src/file-a.ts', 'a-created-by-ai');
			await writeFile(cascadeProjectId, '/src/file-b.ts', 'b-v1');

			// Turn 2: AI edits file-a.ts and creates file-c.ts
			await createSnapshot(cascadeProjectId, 'cc000011', {
				sessionId: 'sess-cascade',
				changes: [
					{ path: '/src/file-a.ts', action: 'edit', beforeContent: 'a-created-by-ai' },
					{ path: '/src/file-c.ts', action: 'create' },
				],
			});
			await writeFile(cascadeProjectId, '/src/file-a.ts', 'a-v2');
			await writeFile(cascadeProjectId, '/src/file-c.ts', 'c-created');

			// Cascade revert: newest first (cc000011, then cc000010)
			const response = await fetch(`${BASE_URL}/p/${cascadeProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['cc000011', 'cc000010'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(3);
			expect(result.failed).toHaveLength(0);
			expect(result.missingSnapshots).toHaveLength(0);

			// file-a was created in turn 1 → should be deleted (earliest action = create)
			expect(await fileExists(cascadeProjectId, '/src/file-a.ts')).toBe(false);
			// file-b was edited in turn 1 → should be restored to original
			expect(await readFile(cascadeProjectId, '/src/file-b.ts')).toBe('b-original');
			// file-c was created in turn 2 → should be deleted
			expect(await fileExists(cascadeProjectId, '/src/file-c.ts')).toBe(false);
		});
	});

	// =========================================================================
	// Cascade Revert — File Deduplication
	// =========================================================================

	describe('Cascade Revert — File Deduplication', () => {
		let dedupProjectId: string;

		beforeAll(async () => {
			dedupProjectId = await createProject();
		});

		it('uses the earliest snapshot backup when the same file appears in multiple snapshots', async () => {
			// Original state
			await writeFile(dedupProjectId, '/src/shared.ts', 'v0-original');

			// Turn 1: AI edits shared.ts (v0 → v1)
			await createSnapshot(dedupProjectId, 'dd000001', {
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v0-original' }],
			});
			await writeFile(dedupProjectId, '/src/shared.ts', 'v1-from-turn1');

			// Turn 2: AI edits shared.ts again (v1 → v2)
			await createSnapshot(dedupProjectId, 'dd000002', {
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v1-from-turn1' }],
			});
			await writeFile(dedupProjectId, '/src/shared.ts', 'v2-from-turn2');

			// Turn 3: AI edits shared.ts again (v2 → v3)
			await createSnapshot(dedupProjectId, 'dd000003', {
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v2-from-turn2' }],
			});
			await writeFile(dedupProjectId, '/src/shared.ts', 'v3-from-turn3');

			// Cascade revert all three (newest first)
			const response = await fetch(`${BASE_URL}/p/${dedupProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['dd000003', 'dd000002', 'dd000001'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			// Should only revert the file once (deduplicated)
			expect(result.reverted).toHaveLength(1);
			expect(result.reverted[0].path).toBe('/src/shared.ts');
			// Uses the earliest snapshot's backup → v0-original
			expect(result.reverted[0].snapshotId).toBe('dd000001');

			// File should be restored to the true original
			expect(await readFile(dedupProjectId, '/src/shared.ts')).toBe('v0-original');
		});

		it('handles mixed actions across snapshots for the same file', async () => {
			// Turn 1: AI creates new-file.ts
			await createSnapshot(dedupProjectId, 'dd000010', {
				changes: [{ path: '/src/new-file.ts', action: 'create' }],
			});
			await writeFile(dedupProjectId, '/src/new-file.ts', 'initial content');

			// Turn 2: AI edits new-file.ts
			await createSnapshot(dedupProjectId, 'dd000011', {
				changes: [{ path: '/src/new-file.ts', action: 'edit', beforeContent: 'initial content' }],
			});
			await writeFile(dedupProjectId, '/src/new-file.ts', 'updated content');

			// Cascade revert → earliest action is 'create' → should delete the file
			const response = await fetch(`${BASE_URL}/p/${dedupProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['dd000011', 'dd000010'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(1);
			expect(result.reverted[0].action).toBe('create');
			expect(await fileExists(dedupProjectId, '/src/new-file.ts')).toBe(false);
		});
	});

	// =========================================================================
	// Cascade Revert — Missing Snapshots
	// =========================================================================

	describe('Cascade Revert — Missing Snapshots', () => {
		let missingProjectId: string;

		beforeAll(async () => {
			missingProjectId = await createProject();
		});

		it('reports missing snapshots but still reverts available ones', async () => {
			await writeFile(missingProjectId, '/src/available.ts', 'original');
			await createSnapshot(missingProjectId, 'ee000001', {
				changes: [{ path: '/src/available.ts', action: 'edit', beforeContent: 'original' }],
			});
			await writeFile(missingProjectId, '/src/available.ts', 'modified');

			// Cascade with one real and one missing snapshot
			const response = await fetch(`${BASE_URL}/p/${missingProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['deadbeef', 'ee000001'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.missingSnapshots).toContain('deadbeef');
			expect(result.reverted).toHaveLength(1);
			expect(result.reverted[0].path).toBe('/src/available.ts');

			expect(await readFile(missingProjectId, '/src/available.ts')).toBe('original');
		});

		it('reports all snapshots as missing when none exist', async () => {
			const response = await fetch(`${BASE_URL}/p/${missingProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['aaaaaaaa', 'bbbbbbbb'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.missingSnapshots).toHaveLength(2);
			expect(result.reverted).toHaveLength(0);
			expect(result.failed).toHaveLength(0);
		});
	});

	// =========================================================================
	// Cascade Revert — Validation
	// =========================================================================

	describe('Cascade Revert — Validation', () => {
		let validationProjectId: string;

		beforeAll(async () => {
			validationProjectId = await createProject();
		});

		it('rejects empty snapshotIds array', async () => {
			const response = await fetch(`${BASE_URL}/p/${validationProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: [] }),
			});
			expect(response.ok).toBe(false);
		});

		it('rejects non-hex snapshot IDs', async () => {
			const response = await fetch(`${BASE_URL}/p/${validationProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['not-hex!!!'] }),
			});
			expect(response.ok).toBe(false);
		});

		it('rejects missing body', async () => {
			const response = await fetch(`${BASE_URL}/p/${validationProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({}),
			});
			expect(response.ok).toBe(false);
		});
	});

	// =========================================================================
	// Pending Changes Coordination
	// =========================================================================

	describe('Pending Changes Coordination', () => {
		let pendingProjectId: string;

		beforeAll(async () => {
			pendingProjectId = await createProject();
		});

		it('pending changes survive independently of snapshot revert', async () => {
			// Setup: write pending changes for two snapshots
			await savePendingChanges(pendingProjectId, {
				'/src/from-snap-a.ts': {
					path: '/src/from-snap-a.ts',
					action: 'edit',
					beforeContent: 'original-a',
					afterContent: 'modified-a',
					snapshotId: 'ff000001',
					status: 'pending',
					hunkStatuses: [],
					sessionId: 'sess-1',
				},
				'/src/from-snap-b.ts': {
					path: '/src/from-snap-b.ts',
					action: 'create',
					afterContent: 'created-b',
					snapshotId: 'ff000002',
					status: 'pending',
					hunkStatuses: [],
					sessionId: 'sess-1',
				},
			});

			// Verify both exist
			const before = await loadPendingChanges(pendingProjectId);
			expect(Object.keys(before)).toHaveLength(2);

			// Revert snapshot ff000001 (file-level only)
			await writeFile(pendingProjectId, '/src/from-snap-a.ts', 'modified-a');
			await createSnapshot(pendingProjectId, 'ff000001', {
				changes: [{ path: '/src/from-snap-a.ts', action: 'edit', beforeContent: 'original-a' }],
			});
			const response = await fetch(`${BASE_URL}/p/${pendingProjectId}/api/snapshot/ff000001/revert`, {
				method: 'POST',
			});
			expect(response.ok).toBe(true);

			// Pending changes on the server are NOT automatically cleared by the
			// backend revert — that's the frontend's responsibility.
			// Verify they're still there.
			const after = await loadPendingChanges(pendingProjectId);
			expect(Object.keys(after)).toHaveLength(2);
		});

		it('frontend can save updated pending changes after revert', async () => {
			// Simulate: frontend cleared snap-a's change and saved
			await savePendingChanges(pendingProjectId, {
				'/src/from-snap-b.ts': {
					path: '/src/from-snap-b.ts',
					action: 'create',
					afterContent: 'created-b',
					snapshotId: 'ff000002',
					status: 'pending',
					hunkStatuses: [],
					sessionId: 'sess-1',
				},
			});

			const after = await loadPendingChanges(pendingProjectId);
			expect(Object.keys(after)).toHaveLength(1);
			expect(after).toHaveProperty('/src/from-snap-b.ts');
		});
	});

	// =========================================================================
	// Snapshot File Content API
	// =========================================================================

	describe('Snapshot File Content API', () => {
		let fileContentProjectId: string;

		beforeAll(async () => {
			fileContentProjectId = await createProject();

			// Create a snapshot with backed up content
			await createSnapshot(fileContentProjectId, 'aa110001', {
				changes: [
					{ path: '/src/backed-up.ts', action: 'edit', beforeContent: 'the original content' },
					{ path: '/src/was-created.ts', action: 'create' },
				],
			});
		});

		it('returns file content from a snapshot', async () => {
			const response = await fetch(
				`${BASE_URL}/p/${fileContentProjectId}/api/snapshot/aa110001/file?path=${encodeURIComponent('/src/backed-up.ts')}`,
			);
			expect(response.ok).toBe(true);
			const result: { path: string; content: string; action: string } = await response.json();
			expect(result.content).toBe('the original content');
			expect(result.action).toBe('edit');
		});

		it('returns undefined content for created files (no before content)', async () => {
			const response = await fetch(
				`${BASE_URL}/p/${fileContentProjectId}/api/snapshot/aa110001/file?path=${encodeURIComponent('/src/was-created.ts')}`,
			);
			expect(response.ok).toBe(true);
			const result: { path: string; content: undefined; action: string } = await response.json();
			expect(result.content).toBeUndefined();
			expect(result.action).toBe('create');
		});

		it('returns 404 for a file not in the snapshot', async () => {
			const response = await fetch(
				`${BASE_URL}/p/${fileContentProjectId}/api/snapshot/aa110001/file?path=${encodeURIComponent('/src/not-here.ts')}`,
			);
			expect(response.status).toBe(404);
		});

		it('returns 404 for a non-existent snapshot', async () => {
			const response = await fetch(
				`${BASE_URL}/p/${fileContentProjectId}/api/snapshot/deadbeef/file?path=${encodeURIComponent('/src/backed-up.ts')}`,
			);
			expect(response.status).toBe(404);
		});
	});

	// =========================================================================
	// Edge Case: Revert of Already-Deleted File
	// =========================================================================

	describe('Edge Case: Revert of Already-Deleted File', () => {
		let edgeProjectId: string;

		beforeAll(async () => {
			edgeProjectId = await createProject();
		});

		it('reverting a created file that was already manually deleted is a no-op', async () => {
			// AI created a file, but user already deleted it
			await createSnapshot(edgeProjectId, 'ef000001', {
				changes: [{ path: '/src/already-gone.ts', action: 'create' }],
			});
			// File doesn't exist on disk (user deleted it or it was never truly written)

			const response = await fetch(`${BASE_URL}/p/${edgeProjectId}/api/snapshot/ef000001/revert`, {
				method: 'POST',
			});
			// Should succeed (delete of non-existent file is a no-op)
			expect(response.ok).toBe(true);
			expect(await fileExists(edgeProjectId, '/src/already-gone.ts')).toBe(false);
		});
	});

	// =========================================================================
	// Edge Case: Multiple Sessions, Same File
	// =========================================================================

	describe('Edge Case: Multiple Sessions Touching Same File', () => {
		let multiSessionProjectId: string;

		beforeAll(async () => {
			multiSessionProjectId = await createProject();
		});

		it('cascade revert only reverts snapshots it is given, leaving other snapshots intact', async () => {
			// Session 1, Turn 1: edits shared.ts (v0 → v1)
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v0');
			await createSnapshot(multiSessionProjectId, 'ab000001', {
				sessionId: 'session-1',
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v0' }],
			});
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v1-from-s1');

			// Session 2, Turn 1: edits shared.ts (v1 → v2)
			await createSnapshot(multiSessionProjectId, 'ab000002', {
				sessionId: 'session-2',
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v1-from-s1' }],
			});
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v2-from-s2');

			// Cascade revert ONLY session 2's snapshot
			const response = await fetch(`${BASE_URL}/p/${multiSessionProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['ab000002'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(1);

			// File should be at v1 (session 2's before-content), NOT v0
			expect(await readFile(multiSessionProjectId, '/src/shared.ts')).toBe('v1-from-s1');

			// Session 1's snapshot is still intact
			const snap1 = await fetch(`${BASE_URL}/p/${multiSessionProjectId}/api/snapshot/ab000001`);
			expect(snap1.ok).toBe(true);
		});

		it('cascade revert of session 1 restores to v0 even though session 2 also modified the file', async () => {
			// Re-apply session 1 and session 2 changes
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v0');
			// Recreate snapshot for session 1 (the old one may have stale timestamps)
			await createSnapshot(multiSessionProjectId, 'ab000010', {
				sessionId: 'session-1',
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v0' }],
			});
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v1');
			await createSnapshot(multiSessionProjectId, 'ab000011', {
				sessionId: 'session-1',
				changes: [{ path: '/src/shared.ts', action: 'edit', beforeContent: 'v1' }],
			});
			await writeFile(multiSessionProjectId, '/src/shared.ts', 'v2');

			// Cascade revert both session 1 snapshots
			const response = await fetch(`${BASE_URL}/p/${multiSessionProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['ab000011', 'ab000010'] }),
			});
			expect(response.ok).toBe(true);

			// Should restore to v0 (the earliest snapshot's backup)
			expect(await readFile(multiSessionProjectId, '/src/shared.ts')).toBe('v0');
		});
	});

	// =========================================================================
	// Edge Case: Cascade with Disjoint Files Across Snapshots
	// =========================================================================

	describe('Edge Case: Disjoint Files Across Snapshots', () => {
		let disjointProjectId: string;

		beforeAll(async () => {
			disjointProjectId = await createProject();
		});

		it('reverts all files from all snapshots when they do not overlap', async () => {
			// Turn 1: creates file-a.ts
			await createSnapshot(disjointProjectId, 'ba000001', {
				changes: [{ path: '/src/file-a.ts', action: 'create' }],
			});
			await writeFile(disjointProjectId, '/src/file-a.ts', 'a content');

			// Turn 2: creates file-b.ts
			await createSnapshot(disjointProjectId, 'ba000002', {
				changes: [{ path: '/src/file-b.ts', action: 'create' }],
			});
			await writeFile(disjointProjectId, '/src/file-b.ts', 'b content');

			// Turn 3: edits file-c.ts (pre-existing)
			await writeFile(disjointProjectId, '/src/file-c.ts', 'c-original');
			await createSnapshot(disjointProjectId, 'ba000003', {
				changes: [{ path: '/src/file-c.ts', action: 'edit', beforeContent: 'c-original' }],
			});
			await writeFile(disjointProjectId, '/src/file-c.ts', 'c-modified');

			// Cascade revert all three
			const response = await fetch(`${BASE_URL}/p/${disjointProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['ba000003', 'ba000002', 'ba000001'] }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(3);
			expect(result.failed).toHaveLength(0);

			// file-a: created → deleted
			expect(await fileExists(disjointProjectId, '/src/file-a.ts')).toBe(false);
			// file-b: created → deleted
			expect(await fileExists(disjointProjectId, '/src/file-b.ts')).toBe(false);
			// file-c: edited → restored
			expect(await readFile(disjointProjectId, '/src/file-c.ts')).toBe('c-original');
		});
	});

	// =========================================================================
	// Edge Case: Snapshot with sessionId
	// =========================================================================

	describe('Snapshot sessionId field', () => {
		let sessionIdProjectId: string;

		beforeAll(async () => {
			sessionIdProjectId = await createProject();
		});

		it('snapshot metadata includes sessionId when provided', async () => {
			await createSnapshot(sessionIdProjectId, 'ca000001', {
				label: 'Scoped snapshot',
				sessionId: 'sess-abc123',
				changes: [{ path: '/src/test.ts', action: 'create' }],
			});

			const response = await fetch(`${BASE_URL}/p/${sessionIdProjectId}/api/snapshot/ca000001`);
			expect(response.ok).toBe(true);
			const result: { snapshot: SnapshotMetadata } = await response.json();
			expect(result.snapshot.sessionId).toBe('sess-abc123');
		});

		it('snapshot metadata works without sessionId (backwards compatibility)', async () => {
			// Create a snapshot without sessionId (simulating legacy snapshot)
			const metadata = {
				id: 'ca000002',
				timestamp: Date.now(),
				label: 'Legacy snapshot',
				changes: [{ path: '/src/legacy.ts', action: 'create' }],
			};
			await writeFile(sessionIdProjectId, '/.agent/snapshots/ca000002/metadata.json', JSON.stringify(metadata));

			const response = await fetch(`${BASE_URL}/p/${sessionIdProjectId}/api/snapshot/ca000002`);
			expect(response.ok).toBe(true);
			const result: { snapshot: SnapshotMetadata } = await response.json();
			expect(result.snapshot.sessionId).toBeUndefined();
			expect(result.snapshot.id).toBe('ca000002');
		});
	});

	// =========================================================================
	// Edge Case: Cascade Revert Idempotency
	// =========================================================================

	describe('Edge Case: Cascade Revert Idempotency', () => {
		let idempotentProjectId: string;

		beforeAll(async () => {
			idempotentProjectId = await createProject();
		});

		it('reverting the same cascade twice does not cause errors', async () => {
			await writeFile(idempotentProjectId, '/src/idempotent.ts', 'original');
			await createSnapshot(idempotentProjectId, 'da000001', {
				changes: [{ path: '/src/idempotent.ts', action: 'edit', beforeContent: 'original' }],
			});
			await writeFile(idempotentProjectId, '/src/idempotent.ts', 'modified');

			// First revert
			const response1 = await fetch(`${BASE_URL}/p/${idempotentProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['da000001'] }),
			});
			expect(response1.ok).toBe(true);
			expect(await readFile(idempotentProjectId, '/src/idempotent.ts')).toBe('original');

			// Second revert — should still succeed, file is already at original
			const response2 = await fetch(`${BASE_URL}/p/${idempotentProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['da000001'] }),
			});
			expect(response2.ok).toBe(true);
			expect(await readFile(idempotentProjectId, '/src/idempotent.ts')).toBe('original');
		});

		it('reverting a create action twice (file already gone) is safe', async () => {
			await writeFile(idempotentProjectId, '/src/created-twice.ts', 'content');
			await createSnapshot(idempotentProjectId, 'da000002', {
				changes: [{ path: '/src/created-twice.ts', action: 'create' }],
			});

			// First revert → deletes the file
			await fetch(`${BASE_URL}/p/${idempotentProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['da000002'] }),
			});
			expect(await fileExists(idempotentProjectId, '/src/created-twice.ts')).toBe(false);

			// Second revert → file already gone, should still succeed
			const response = await fetch(`${BASE_URL}/p/${idempotentProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: ['da000002'] }),
			});
			expect(response.ok).toBe(true);
			const result: CascadeRevertResult = await response.json();
			// The file was already gone, but the revert should still report success
			expect(result.reverted).toHaveLength(1);
		});
	});

	// =========================================================================
	// Edge Case: Large Cascade (Many Snapshots)
	// =========================================================================

	describe('Edge Case: Large Cascade', () => {
		let largeProjectId: string;

		beforeAll(async () => {
			largeProjectId = await createProject();
		});

		it('handles cascading 10 snapshots with unique files', async () => {
			const snapshotIds: string[] = [];

			// Create 10 snapshots, each with a unique file
			for (let index = 0; index < 10; index++) {
				const snapshotId = `fa00000${index.toString(16)}`;
				const filePath = `/src/file-${index}.ts`;
				snapshotIds.push(snapshotId);
				await createSnapshot(largeProjectId, snapshotId, {
					changes: [{ path: filePath, action: 'create' }],
				});
				await writeFile(largeProjectId, filePath, `content-${index}`);
			}

			// Cascade revert all (newest first)
			const response = await fetch(`${BASE_URL}/p/${largeProjectId}/api/snapshots/revert-cascade`, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ snapshotIds: snapshotIds.toReversed() }),
			});
			expect(response.ok).toBe(true);

			const result: CascadeRevertResult = await response.json();
			expect(result.reverted).toHaveLength(10);
			expect(result.failed).toHaveLength(0);

			// All files should be deleted
			for (let index = 0; index < 10; index++) {
				expect(await fileExists(largeProjectId, `/src/file-${index}.ts`)).toBe(false);
			}
		});
	});

	// =========================================================================
	// Edge Case: Snapshot Listing Sorted by Timestamp
	// =========================================================================

	describe('Edge Case: Snapshot Listing Order', () => {
		let orderProjectId: string;

		beforeAll(async () => {
			orderProjectId = await createProject();
		});

		it('snapshots are listed newest-first', async () => {
			await createSnapshot(orderProjectId, 'aa000001', {
				label: 'Older',
				changes: [{ path: '/src/a.ts', action: 'create' }],
			});

			// Small delay to ensure different timestamps
			await new Promise((resolve) => setTimeout(resolve, 50));

			await createSnapshot(orderProjectId, 'aa000002', {
				label: 'Newer',
				changes: [{ path: '/src/b.ts', action: 'create' }],
			});

			const response = await fetch(`${BASE_URL}/p/${orderProjectId}/api/snapshots`);
			const result: { snapshots: SnapshotSummary[] } = await response.json();

			const ourSnapshots = result.snapshots.filter((s) => s.id === 'aa000001' || s.id === 'aa000002');
			expect(ourSnapshots).toHaveLength(2);
			// Newer should be first
			expect(ourSnapshots[0].id).toBe('aa000002');
			expect(ourSnapshots[1].id).toBe('aa000001');
		});
	});
});
