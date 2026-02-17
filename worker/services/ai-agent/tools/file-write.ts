/**
 * Tool: file_write
 * Create new files or overwrite existing ones.
 */

import fs from 'node:fs/promises';

import { exports } from 'cloudflare:workers';

import { isPathSafe } from '../../../lib/path-utilities';
import { isBinaryFilePath, toUint8Array } from '../utilities';

import type { FileChange, SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Write a file to the project. Creates a new file or overwrites an existing file with the provided content.

Usage:
- This tool will overwrite the existing file if there is one at the provided path.
- If this is an existing file, you MUST use the file_read tool first to read the file's contents. This tool will fail if you did not read the file first.
- ALWAYS prefer editing existing files in the codebase using the file_edit tool. NEVER write new files unless explicitly required.
- NEVER proactively create documentation files (*.md) or README files. Only create documentation files if explicitly requested by the user.
- Parent directories are created automatically if they don't exist.
- The content parameter must contain the complete file content.`;

export const definition: ToolDefinition = {
	name: 'file_write',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			path: { type: 'string', description: 'File path starting with /, e.g., /src/utils.ts' },
			content: { type: 'string', description: 'The complete file content to write' },
		},
		required: ['path', 'content'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
): Promise<string | object> {
	const { projectRoot, projectId } = context;
	const writePath = input.path;
	const writeContent = input.content;

	if (!isPathSafe(projectRoot, writePath)) {
		return { error: 'Invalid file path' };
	}

	if (writePath === '/package.json') {
		return {
			error:
				'Cannot create package.json directly. Dependencies are managed at the project level. Use the dependencies_update tool to add, remove, or update dependencies.',
		};
	}

	await sendEvent('status', { message: `Writing ${writePath}...` });

	const writeDirectory = writePath.slice(0, writePath.lastIndexOf('/'));
	if (writeDirectory) {
		await fs.mkdir(`${projectRoot}${writeDirectory}`, { recursive: true });
	}

	const writeIsBinary = isBinaryFilePath(writePath);
	// eslint-disable-next-line unicorn/no-null -- JSON wire format for SSE events
	let beforeContent: string | Uint8Array | null = null;
	let action: 'create' | 'edit' = 'create';
	try {
		if (writeIsBinary) {
			const buffer = await fs.readFile(`${projectRoot}${writePath}`);
			beforeContent = toUint8Array(buffer);
		} else {
			beforeContent = await fs.readFile(`${projectRoot}${writePath}`, 'utf8');
		}
		action = 'edit';
	} catch {
		action = 'create';
	}

	await fs.writeFile(`${projectRoot}${writePath}`, writeContent);

	if (queryChanges) {
		queryChanges.push({
			path: writePath,
			action,
			beforeContent,
			afterContent: writeContent,
			isBinary: writeIsBinary,
		});
	}

	const coordinatorId = exports.ProjectCoordinator.idFromName(`project:${projectId}`);
	const coordinatorStub = exports.ProjectCoordinator.get(coordinatorId);
	const isCSS = writePath.endsWith('.css');
	await coordinatorStub.triggerUpdate({
		type: isCSS ? 'update' : 'full-reload',
		path: writePath,
		timestamp: Date.now(),
		isCSS,
	});

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

	return { success: true, path: writePath, action };
}
