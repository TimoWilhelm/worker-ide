/**
 * Tool: dependencies_list
 * List all registered project dependencies from package.json.
 */

import { readDependencies } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'dependencies_list',
	description:
		'List all project dependencies from package.json. Returns the current dependency map (name → version). Use this to check which packages are available before importing them.',
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

	sendEvent('status', { message: 'Listing dependencies...' });

	const dependencies = await readDependencies(projectRoot);
	const output = Object.entries(dependencies)
		.map(([name, version]) => `${name}: ${version}`)
		.join('\n');
	return { title: 'dependencies', metadata: { dependencies }, output: output || 'No dependencies registered.' };
}
