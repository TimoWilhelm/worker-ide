/**
 * Tool: dependencies_list
 * List all registered project dependencies.
 */

import fs from 'node:fs/promises';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { ProjectMeta } from '@shared/types';

export const definition: ToolDefinition = {
	name: 'dependencies_list',
	description:
		'List all registered project dependencies. Returns the current dependency map (name → version). Use this to check which packages are available before importing them.',
	input_schema: {
		type: 'object',
		properties: {},
	},
};

export async function execute(
	_input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot } = context;

	await sendEvent('status', { message: 'Listing dependencies...' });

	try {
		const metaRaw = await fs.readFile(`${projectRoot}/.project-meta.json`, 'utf8');
		const meta: ProjectMeta = JSON.parse(metaRaw);
		const dependencies = meta.dependencies ?? {};
		const output = Object.entries(dependencies)
			.map(([name, version]) => `${name}: ${version}`)
			.join('\n');
		return { title: 'dependencies', metadata: { dependencies }, output: output || 'No dependencies registered.' };
	} catch {
		return { title: 'dependencies', metadata: { dependencies: {} }, output: 'No project metadata found.' };
	}
}
