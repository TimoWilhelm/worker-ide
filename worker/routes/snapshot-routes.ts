/**
 * Snapshot management routes.
 * Handles listing, viewing, and reverting project snapshots.
 */

import fs from 'node:fs/promises';

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';
import { z } from 'zod';

import { BINARY_EXTENSIONS } from '@shared/constants';
import { snapshotIdSchema, revertFileSchema, filePathSchema } from '@shared/validation';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';

import type { AppEnvironment } from '../types';

/**
 * Snapshot metadata stored in each snapshot directory.
 */
interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	changes: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>;
}

/**
 * Check if a file path is for a binary file.
 */
function isBinaryFilePath(path: string): boolean {
	const extension = path.match(/\.[^.]+$/)?.[0]?.toLowerCase() || '';
	return BINARY_EXTENSIONS.has(extension);
}

/**
 * Snapshot routes - all routes are prefixed with /api
 */
export const snapshotRoutes = new Hono<AppEnvironment>()
	// GET /api/snapshots - List all snapshots
	.get('/snapshots', async (c) => {
		const projectRoot = c.get('projectRoot');
		const snapshots = await listSnapshots(projectRoot);
		return c.json({ snapshots });
	})

	// GET /api/snapshot/:id - Get snapshot details
	.get('/snapshot/:id', zValidator('param', z.object({ id: snapshotIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const { id } = c.req.valid('param');

		const metadata = await getSnapshotMetadata(projectRoot, id);
		if (!metadata) {
			return c.json({ error: 'Snapshot not found' }, 404);
		}

		return c.json({ snapshot: metadata });
	})

	// POST /api/snapshot/:id/revert - Revert entire snapshot
	.post('/snapshot/:id/revert', zValidator('param', z.object({ id: snapshotIdSchema })), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { id } = c.req.valid('param');

		const success = await revertSnapshot(projectRoot, id, projectId);
		if (!success) {
			return c.json({ error: 'Failed to revert snapshot' }, 500);
		}

		return c.json({ success: true });
	})

	// POST /api/snapshot/revert-file - Revert a single file from a snapshot
	.post('/snapshot/revert-file', zValidator('json', revertFileSchema), async (c) => {
		const projectRoot = c.get('projectRoot');
		const projectId = c.get('projectId');
		const { path, snapshotId } = c.req.valid('json');

		const success = await revertFileFromSnapshot(projectRoot, path, snapshotId, projectId);
		if (!success) {
			return c.json({ error: 'Failed to revert file' }, 500);
		}

		return c.json({ success: true });
	})

	// GET /api/snapshot/:id/file?path=/src/main.ts - Get file content from snapshot
	.get(
		'/snapshot/:id/file',
		zValidator('param', z.object({ id: snapshotIdSchema })),
		zValidator('query', z.object({ path: filePathSchema })),
		async (c) => {
			const projectRoot = c.get('projectRoot');
			const { id } = c.req.valid('param');
			const { path } = c.req.valid('query');

			const snapshotDirectory = `${projectRoot}/.agent/snapshots/${id}`;
			const metadata = await getSnapshotMetadata(projectRoot, id);

			if (!metadata) {
				return c.json({ error: 'Snapshot not found' }, 404);
			}

			const change = metadata.changes.find((ch) => ch.path === path);
			if (!change) {
				return c.json({ error: 'File not in snapshot' }, 404);
			}

			// For created files, there's no before content
			if (change.action === 'create') {
				return c.json({ path, content: undefined, action: 'create' });
			}

			try {
				const isBinary = isBinaryFilePath(path);
				if (isBinary) {
					// For binary files, just indicate it exists
					return c.json({ path, content: undefined, action: change.action, isBinary: true });
				}

				const content = await fs.readFile(`${snapshotDirectory}${path}`, 'utf8');
				return c.json({ path, content, action: change.action });
			} catch {
				return c.json({ error: 'File not found in snapshot' }, 404);
			}
		},
	);

/**
 * List all available snapshots with their metadata.
 */
async function listSnapshots(projectRoot: string): Promise<Array<{ id: string; timestamp: number; label: string; changeCount: number }>> {
	const snapshotsDirectory = `${projectRoot}/.agent/snapshots`;
	const snapshots: Array<{ id: string; timestamp: number; label: string; changeCount: number }> = [];

	try {
		const entries = await fs.readdir(snapshotsDirectory);
		for (const entry of entries) {
			try {
				const metadataPath = `${snapshotsDirectory}/${entry}/metadata.json`;
				const metadataRaw = await fs.readFile(metadataPath, 'utf8');
				const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
				snapshots.push({
					id: metadata.id,
					timestamp: metadata.timestamp,
					label: metadata.label,
					changeCount: metadata.changes.length,
				});
			} catch {
				// Skip invalid snapshot directories
			}
		}
	} catch {
		// Snapshots directory may not exist yet
	}

	return snapshots.toSorted((a, b) => b.timestamp - a.timestamp);
}

/**
 * Get full metadata for a specific snapshot.
 */
async function getSnapshotMetadata(projectRoot: string, snapshotId: string): Promise<SnapshotMetadata | undefined> {
	try {
		const metadataPath = `${projectRoot}/.agent/snapshots/${snapshotId}/metadata.json`;
		const metadataRaw = await fs.readFile(metadataPath, 'utf8');
		const metadata: SnapshotMetadata = JSON.parse(metadataRaw);
		return metadata;
	} catch {
		return undefined;
	}
}

/**
 * Revert a single file to its state in a snapshot.
 */
async function revertSingleFile(
	projectRoot: string,
	path: string,
	action: 'create' | 'edit' | 'delete',
	snapshotDirectory: string,
	projectId: string,
): Promise<void> {
	const isBinary = isBinaryFilePath(path);

	if (action === 'create') {
		// File was created by the agent, delete it to revert
		try {
			await fs.unlink(`${projectRoot}${path}`);
		} catch {
			// File may already be deleted
		}
	} else {
		// File was edited or deleted, restore from snapshot
		const snapshotFilePath = `${snapshotDirectory}${path}`;
		try {
			const beforeContent = isBinary ? await fs.readFile(snapshotFilePath) : await fs.readFile(snapshotFilePath, 'utf8');

			// Ensure directory exists
			const directory = path.slice(0, path.lastIndexOf('/'));
			if (directory) {
				await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
			}

			await fs.writeFile(`${projectRoot}${path}`, beforeContent);
		} catch (error) {
			console.error(`Failed to restore file ${path} from snapshot:`, error);
		}
	}

	// Trigger HMR for the reverted file
	try {
		const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);
		await coordinatorStub.triggerUpdate({
			type: 'full-reload',
			path,
			timestamp: Date.now(),
			isCSS: false,
		});
	} catch {
		// HMR trigger failure is non-fatal
	}
}

/**
 * Revert all files in a snapshot to their previous state.
 */
async function revertSnapshot(projectRoot: string, snapshotId: string, projectId: string): Promise<boolean> {
	const snapshotDirectory = `${projectRoot}/.agent/snapshots/${snapshotId}`;

	try {
		const metadata = await getSnapshotMetadata(projectRoot, snapshotId);
		if (!metadata) return false;

		for (const change of metadata.changes) {
			await revertSingleFile(projectRoot, change.path, change.action, snapshotDirectory, projectId);
		}

		return true;
	} catch (error) {
		console.error('Failed to revert snapshot:', error);
		return false;
	}
}

/**
 * Revert a single file from a specific snapshot.
 */
async function revertFileFromSnapshot(projectRoot: string, path: string, snapshotId: string, projectId: string): Promise<boolean> {
	const snapshotDirectory = `${projectRoot}/.agent/snapshots/${snapshotId}`;

	try {
		const metadata = await getSnapshotMetadata(projectRoot, snapshotId);
		if (!metadata) return false;

		const change = metadata.changes.find((ch) => ch.path === path);
		if (!change) return false;

		await revertSingleFile(projectRoot, path, change.action, snapshotDirectory, projectId);
		return true;
	} catch (error) {
		console.error('Failed to revert file from snapshot:', error);
		return false;
	}
}

export type SnapshotRoutes = typeof snapshotRoutes;
