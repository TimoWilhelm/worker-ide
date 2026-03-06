/**
 * Tool: asset_settings_get
 * Read the current Cloudflare Workers asset routing settings for the project.
 */

import fs from 'node:fs/promises';

import { resolveAssetSettings } from '@shared/types';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { ProjectMeta } from '@shared/types';

export const definition: ToolDefinition = {
	name: 'asset_settings_get',
	description: `Read the current Cloudflare Workers asset routing settings for the project.
Returns the configured not_found_handling, html_handling, and run_worker_first values.
These control how deployed Workers handle static assets, 404 pages, HTML routing, and worker-first routing.`,
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

	let rawSettings;
	try {
		const metaRaw = await fs.readFile(`${projectRoot}/.project-meta.json`, 'utf8');
		const meta: ProjectMeta = JSON.parse(metaRaw);
		rawSettings = meta.assetSettings;
	} catch {
		// Use defaults if metadata is missing
	}

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
