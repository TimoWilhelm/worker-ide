/**
 * Tool: bindings_get
 * Read the current bindings configuration for the project.
 */

import { stripIndent } from 'common-tags';

import { readBindingsConfig } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'bindings_get',
	description: stripIndent`
    Read the current bindings configuration for the project.
    Returns which bindings are enabled (e.g. storage). Bindings are configured in wrangler.jsonc and control what is available in the user's worker env object.
  `,
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

	sendEvent('status', { message: 'Reading bindings config...' });

	const bindingsConfig = await readBindingsConfig(projectRoot);

	const lines: string[] = [`storage: ${bindingsConfig.storage ? 'enabled' : 'disabled'} (Object Storage / R2, available as env.STORAGE)`];

	return {
		title: 'bindings config',
		metadata: { bindingsConfig },
		output: lines.join('\n'),
	};
}
