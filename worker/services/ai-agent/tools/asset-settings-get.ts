/**
 * Tool: asset_settings_get
 * Read the current Cloudflare Workers asset routing settings for the project.
 */

import { stripIndent } from 'common-tags';

import { resolveAssetSettings } from '@shared/types';
import { readAssetSettings } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

export const definition: ToolDefinition = {
	name: 'asset_settings_get',
	description: stripIndent`
		Read the current Cloudflare Workers asset routing settings for the project.
		Returns the configured not_found_handling, html_handling, and run_worker_first values.
		These control how deployed Workers handle static assets, 404 pages, HTML routing, and worker-first routing.
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

	sendEvent('status', { message: 'Reading asset settings...' });

	const rawSettings = await readAssetSettings(projectRoot);
	const settings = resolveAssetSettings(rawSettings);

	const runWorkerFirstDisplay = Array.isArray(settings.run_worker_first)
		? `[${settings.run_worker_first.join(', ')}]`
		: String(settings.run_worker_first);

	return {
		title: 'asset settings',
		metadata: { assetSettings: settings },
		output: [
			`not_found_handling: ${settings.not_found_handling} (options: none, single-page-application, 404-page)`,
			`html_handling: ${settings.html_handling} (options: auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none)`,
			`run_worker_first: ${runWorkerFirstDisplay}`,
		].join('\n'),
	};
}
