/**
 * Tool: dependencies_update
 * Add, remove, or update a project dependency.
 */

import fs from 'node:fs/promises';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';
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
): Promise<string | object> {
	const { projectRoot } = context;
	const { action, name, version } = input;

	if (!name) {
		return { error: 'Package name is required.' };
	}

	const metaPath = `${projectRoot}/.project-meta.json`;

	await sendEvent('status', { message: `Updating dependency: ${name}...` });

	let meta: ProjectMeta;
	try {
		const metaRaw = await fs.readFile(metaPath, 'utf8');
		meta = JSON.parse(metaRaw);
	} catch {
		return { error: 'No project metadata found. Cannot manage dependencies.' };
	}

	const dependencies = meta.dependencies ?? {};

	switch (action) {
		case 'add': {
			if (dependencies[name]) {
				return { error: `Dependency "${name}" already exists with version "${dependencies[name]}". Use action "update" to change it.` };
			}
			dependencies[name] = version || '*';
			break;
		}
		case 'remove': {
			if (!dependencies[name]) {
				return { error: `Dependency "${name}" is not registered.` };
			}
			delete dependencies[name];
			break;
		}
		case 'update': {
			if (!dependencies[name]) {
				return { error: `Dependency "${name}" is not registered. Use action "add" to add it first.` };
			}
			dependencies[name] = version || '*';
			break;
		}
		default: {
			return { error: `Unknown action "${action}". Use "add", "remove", or "update".` };
		}
	}

	meta.dependencies = dependencies;
	await fs.writeFile(metaPath, JSON.stringify(meta));

	return { success: true, action, name, dependencies };
}
