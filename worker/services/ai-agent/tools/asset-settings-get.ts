/**
 * Tool: asset_settings_get
 * Read the current Cloudflare Workers asset routing settings for the project.
 */

import fs from 'node:fs/promises';

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

	try {
		const metaRaw = await fs.readFile(`${projectRoot}/.project-meta.json`, 'utf8');
		const meta: ProjectMeta = JSON.parse(metaRaw);
		const settings = meta.assetSettings ?? {};

		const lines: string[] = [
			`not_found_handling: ${settings.not_found_handling ?? 'none'} (options: none, single-page-application, 404-page)`,
			`html_handling: ${settings.html_handling ?? 'auto-trailing-slash'} (options: auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none)`,
		];

		const runWorkerFirst = settings.run_worker_first ?? false;
		if (Array.isArray(runWorkerFirst)) {
			lines.push(`run_worker_first: [${runWorkerFirst.join(', ')}]`);
		} else {
			lines.push(`run_worker_first: ${String(runWorkerFirst)}`);
		}

		return {
			title: 'asset settings',
			metadata: { assetSettings: settings },
			output: lines.join('\n'),
		};
	} catch {
		return {
			title: 'asset settings',
			metadata: { assetSettings: {} },
			output:
				'No asset settings configured (using defaults: not_found_handling=none, html_handling=auto-trailing-slash, run_worker_first=false).',
		};
	}
}
