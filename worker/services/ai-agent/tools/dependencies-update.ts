/**
 * Tool: dependencies_update
 * Add, remove, or update a project dependency.
 */

import fs from 'node:fs/promises';

import { ToolExecutionError } from '@shared/tool-errors';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { ProjectMeta } from '@shared/types';

export const definition: ToolDefinition = {
	name: 'dependencies_update',
	description: `Add, remove, or update a project dependency. Dependencies are managed at the project level (not via package.json).
CRITICAL INSTRUCTION: You MUST register a dependency before importing it in code. Use dependencies_list to see current dependencies.`,
	input_schema: {
		type: 'object',
		properties: {
			action: {
				type: 'string',
				description: 'The action to perform: "add", "remove", or "update"',
				enum: ['add', 'remove', 'update'],
			},
			name: {
				type: 'string',
				description: 'The npm package name (e.g. "hono", "@scope/pkg")',
			},
			version: {
				type: 'string',
				description: 'The version specifier (e.g. "^4.0.0", "*"). Defaults to "*" when adding.',
			},
		},
		required: ['action', 'name'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot } = context;
	const { action, name, version } = input;

	if (!name) {
		throw new ToolExecutionError('MISSING_INPUT', 'Package name is required.');
	}

	const metaPath = `${projectRoot}/.project-meta.json`;

	sendEvent('status', { message: `Updating dependency: ${name}...` });

	let meta: ProjectMeta;
	try {
		const metaRaw = await fs.readFile(metaPath, 'utf8');
		meta = JSON.parse(metaRaw);
	} catch {
		throw new ToolExecutionError('FILE_NOT_FOUND', 'No project metadata found. Cannot manage dependencies.');
	}

	const dependencies = meta.dependencies ?? {};
	let removedVersion: string | undefined;

	switch (action) {
		case 'add': {
			if (dependencies[name]) {
				throw new ToolExecutionError(
					'NOT_ALLOWED',
					`Dependency "${name}" already exists with version "${dependencies[name]}". Use action "update" to change it.`,
				);
			}
			dependencies[name] = version || '*';
			break;
		}
		case 'remove': {
			if (!dependencies[name]) {
				throw new ToolExecutionError('NOT_ALLOWED', `Dependency "${name}" is not registered.`);
			}
			removedVersion = dependencies[name];
			delete dependencies[name];
			break;
		}
		case 'update': {
			if (!dependencies[name]) {
				throw new ToolExecutionError('NOT_ALLOWED', `Dependency "${name}" is not registered. Use action "add" to add it first.`);
			}
			dependencies[name] = version || '*';
			break;
		}
		default: {
			throw new ToolExecutionError('MISSING_INPUT', `Unknown action "${action}". Use "add", "remove", or "update".`);
		}
	}

	meta.dependencies = dependencies;
	await fs.writeFile(metaPath, JSON.stringify(meta));

	// Notify connected clients so the dependencies panel and project metadata
	// refresh immediately without waiting for the React Query stale time.
	const coordinatorId = coordinatorNamespace.idFromName(`project:${context.projectId}`);
	const coordinatorStub = coordinatorNamespace.get(coordinatorId);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: '/.project-meta.json', timestamp: Date.now(), isCSS: false });

	const verbMap: Record<string, string> = { add: 'Added', remove: 'Removed', update: 'Updated' };
	const verb = verbMap[action] ?? action;

	return {
		title: name,
		metadata: { action, name, version: removedVersion ?? dependencies[name], dependencies },
		output: action === 'remove' ? `${verb} ${name}` : `${verb} ${name}@${dependencies[name] || '*'}`,
	};
}
