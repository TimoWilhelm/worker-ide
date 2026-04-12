/**
 * Tool: bindings_update
 * Enable or disable IDE-managed bindings for the project.
 */

import { ToolExecutionError } from '@shared/tool-errors';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { readBindingsConfig, regenerateProtectedFiles, writeBindingsConfig } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { BindingsConfig } from '@shared/types';

export const definition: ToolDefinition = {
	name: 'bindings_update',
	description: `Enable or disable IDE-managed bindings for the project.
Currently supported bindings:
- storage: Object storage (R2-backed) available as env.STORAGE — exposes a subset of the R2Bucket API (head, get, put, delete, list).

When enabled, the IDE auto-generates type declarations in worker-env.d.ts and injects the binding into the preview worker env.
When deploying, an R2 bucket is automatically created in the user's account.`,
	input_schema: {
		type: 'object',
		properties: {
			storage: {
				type: 'string',
				description: 'Enable or disable object storage binding: "true" or "false"',
			},
		},
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const { projectRoot, projectId } = context;

	sendEvent('status', { message: 'Updating bindings config...' });

	const bindingsConfig: BindingsConfig = await readBindingsConfig(projectRoot);
	const changes: string[] = [];

	if (input.storage !== undefined) {
		const value = input.storage.trim().toLowerCase();
		if (value !== 'true' && value !== 'false') {
			throw new ToolExecutionError('NOT_ALLOWED', `Invalid storage value: "${input.storage}". Must be "true" or "false"`);
		}
		const enabled = value === 'true';
		bindingsConfig.storage = enabled || undefined;
		changes.push(`storage = ${enabled ? 'enabled' : 'disabled'}`);
	}

	if (changes.length === 0) {
		return {
			title: 'no changes',
			metadata: { bindingsConfig },
			output: 'No bindings were provided to update.',
		};
	}

	await writeBindingsConfig(projectRoot, bindingsConfig);
	await regenerateProtectedFiles(projectRoot);

	// Trigger full reload so the preview picks up new bindings
	const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: '/wrangler.jsonc', timestamp: Date.now(), isCSS: false });

	return {
		title: 'bindings updated',
		metadata: { bindingsConfig, changes },
		output: `Updated bindings:\n${changes.join('\n')}`,
	};
}
