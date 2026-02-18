/**
 * Tool: file_write
 * Create new files or overwrite existing ones.
 * Integrates with FileTime to ensure files are read before being overwritten.
 */

import fs from 'node:fs/promises';

import { exports } from 'cloudflare:workers';

import { ToolErrorCode, toolError } from '@shared/tool-errors';

import { isPathSafe } from '../../../lib/path-utilities';
import { assertFileWasRead, recordFileRead } from '../file-time';
import { isBinaryFilePath, toUint8Array } from '../utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

// =============================================================================
// Description (matches OpenCode)
// =============================================================================

export const DESCRIPTION = `Writes a file to the local filesystem.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the Read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the User.`;

// =============================================================================
// Tool Definition
// =============================================================================

export const definition: ToolDefinition = {
	name: 'file_write',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'The absolute path to the file to write (must be absolute, not relative)' },
			content: { type: 'string', description: 'The content to write to the file' },
		},
		required: ['path', 'content'],
	},
};

// =============================================================================
// Execute Function
// =============================================================================

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string> {
	const { projectRoot, projectId, sessionId } = context;
	const writePath = input.path;
	const writeContent = input.content;

	// Validate path
	if (!isPathSafe(projectRoot, writePath)) {
		return toolError(ToolErrorCode.INVALID_PATH, 'Invalid file path');
	}

	// Prevent direct package.json creation
	if (writePath === '/package.json') {
		return toolError(
			ToolErrorCode.NOT_ALLOWED,
			'Cannot create package.json directly. Dependencies are managed at the project level. Use the dependencies_update tool to add, remove, or update dependencies.',
		);
	}

	// Check if file exists
	let fileExists = false;
	// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
	let beforeContent: string | Uint8Array | null = null;
	const writeIsBinary = isBinaryFilePath(writePath);

	try {
		if (writeIsBinary) {
			const buffer = await fs.readFile(`${projectRoot}${writePath}`);
			beforeContent = toUint8Array(buffer);
		} else {
			beforeContent = await fs.readFile(`${projectRoot}${writePath}`, 'utf8');
		}
		fileExists = true;
	} catch {
		fileExists = false;
	}

	// If file exists, verify it was read first (if session tracking is available)
	if (fileExists && sessionId) {
		try {
			await assertFileWasRead(projectRoot, sessionId, writePath);
		} catch (error) {
			return toolError(
				ToolErrorCode.FILE_NOT_READ,
				error instanceof Error ? error.message : 'You must read the file before overwriting it.',
			);
		}
	}

	await sendEvent('status', { message: `Writing ${writePath}...` });

	// Create parent directories if needed
	const writeDirectory = writePath.slice(0, writePath.lastIndexOf('/'));
	if (writeDirectory) {
		await fs.mkdir(`${projectRoot}${writeDirectory}`, { recursive: true });
	}

	// Write the file
	await fs.writeFile(`${projectRoot}${writePath}`, writeContent);

	// Record as read for subsequent operations (both create and edit)
	if (sessionId) {
		await recordFileRead(projectRoot, sessionId, writePath);
	}

	const action: 'create' | 'edit' = fileExists ? 'edit' : 'create';

	// Track file change for snapshots
	if (queryChanges) {
		queryChanges.push({
			path: writePath,
			action,
			beforeContent,
			afterContent: writeContent,
			isBinary: writeIsBinary,
		});
	}

	// Trigger live reload
	const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
	const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
	const isCSS = writePath.endsWith('.css');
	await coordinatorStub.triggerUpdate({
		type: isCSS ? 'update' : 'full-reload',
		path: writePath,
		timestamp: Date.now(),
		isCSS,
	});

	// Send file changed event for UI
	await sendEvent('file_changed', {
		path: writePath,
		action,
		tool_use_id: toolUseId,
		// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
		beforeContent: writeIsBinary ? null : beforeContent,
		// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
		afterContent: writeIsBinary ? null : writeContent,
		isBinary: writeIsBinary,
	});

	return 'Wrote file successfully.';
}
