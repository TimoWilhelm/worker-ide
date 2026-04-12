/**
 * Tool: asset_settings_update
 * Update Cloudflare Workers asset routing settings for the project.
 */

import { stripIndent } from 'common-tags';

import { ToolExecutionError } from '@shared/tool-errors';
import { coordinatorNamespace } from '@worker/lib/durable-object-namespaces';
import { readAssetSettings, regenerateProtectedFiles, writeAssetSettings } from '@worker/lib/protected-files';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';
import type { AssetSettings, HtmlHandling, NotFoundHandling } from '@shared/types';

const VALID_NOT_FOUND_HANDLING: Record<string, NotFoundHandling> = {
	none: 'none',
	'single-page-application': 'single-page-application',
	'404-page': '404-page',
};

const VALID_HTML_HANDLING: Record<string, HtmlHandling> = {
	'auto-trailing-slash': 'auto-trailing-slash',
	'force-trailing-slash': 'force-trailing-slash',
	'drop-trailing-slash': 'drop-trailing-slash',
	none: 'none',
};

export const definition: ToolDefinition = {
	name: 'asset_settings_update',
	description: stripIndent`
    Update Cloudflare Workers asset routing settings for the project.
    These settings control how the deployed Worker handles static assets, 404 pages, HTML routing, and worker-first routing.
    They also affect the preview behavior in the IDE.

    Available settings:
    - not_found_handling: "none" | "single-page-application" | "404-page" (default: "none")
      Controls what happens when a request doesn't match a static asset.
      Use "single-page-application" for SPAs (serves index.html for unmatched routes).
      Use "404-page" for static sites (serves nearest 404.html).

    - html_handling: "auto-trailing-slash" | "force-trailing-slash" | "drop-trailing-slash" | "none" (default: "auto-trailing-slash")
      Controls trailing slash redirect behavior for HTML pages.

    - run_worker_first: "true" | "false" | comma-separated route patterns (default: "false")
      Controls whether the Worker runs before serving static assets.
      Use "true" to always run the Worker first.
      Use route patterns like "/api/*,!/api/docs/*" for selective routing.
  `,
	input_schema: {
		type: 'object',
		properties: {
			not_found_handling: {
				type: 'string',
				description: 'How to handle requests that don\'t match a static asset: "none", "single-page-application", or "404-page"',
			},
			html_handling: {
				type: 'string',
				description: 'Trailing slash behavior for HTML: "auto-trailing-slash", "force-trailing-slash", "drop-trailing-slash", or "none"',
			},
			run_worker_first: {
				type: 'string',
				description: 'Whether Worker runs before assets: "true", "false", or comma-separated route patterns like "/api/*,!/api/docs/*"',
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

	sendEvent('status', { message: 'Updating asset settings...' });

	const assetSettings: AssetSettings = await readAssetSettings(projectRoot);
	const changes: string[] = [];

	// Update not_found_handling
	if (input.not_found_handling !== undefined) {
		const parsedNotFound = VALID_NOT_FOUND_HANDLING[input.not_found_handling];
		if (!parsedNotFound) {
			throw new ToolExecutionError(
				'NOT_ALLOWED',
				`Invalid not_found_handling: "${input.not_found_handling}". Must be one of: none, single-page-application, 404-page`,
			);
		}
		if (parsedNotFound === 'none') {
			delete assetSettings.not_found_handling;
		} else {
			assetSettings.not_found_handling = parsedNotFound;
		}
		changes.push(`not_found_handling = ${input.not_found_handling}`);
	}

	// Update html_handling
	if (input.html_handling !== undefined) {
		const parsedHtml = VALID_HTML_HANDLING[input.html_handling];
		if (!parsedHtml) {
			throw new ToolExecutionError(
				'NOT_ALLOWED',
				`Invalid html_handling: "${input.html_handling}". Must be one of: auto-trailing-slash, force-trailing-slash, drop-trailing-slash, none`,
			);
		}
		if (parsedHtml === 'auto-trailing-slash') {
			delete assetSettings.html_handling;
		} else {
			assetSettings.html_handling = parsedHtml;
		}
		changes.push(`html_handling = ${input.html_handling}`);
	}

	// Update run_worker_first
	if (input.run_worker_first !== undefined) {
		const value = input.run_worker_first.trim();
		if (value === 'true') {
			assetSettings.run_worker_first = true;
			changes.push('run_worker_first = true');
		} else if (value === 'false') {
			delete assetSettings.run_worker_first;
			changes.push('run_worker_first = false');
		} else {
			// Parse as comma-separated patterns
			const patterns = value
				.split(',')
				.map((p) => p.trim())
				.filter(Boolean);

			for (const pattern of patterns) {
				if (!pattern.startsWith('/') && !pattern.startsWith('!/')) {
					throw new ToolExecutionError('NOT_ALLOWED', `Invalid route pattern: "${pattern}". Patterns must begin with / or !/`);
				}
			}

			assetSettings.run_worker_first = patterns;
			changes.push(`run_worker_first = [${patterns.join(', ')}]`);
		}
	}

	if (changes.length === 0) {
		return {
			title: 'no changes',
			metadata: { assetSettings },
			output: 'No settings were provided to update.',
		};
	}

	// Write asset settings to wrangler.jsonc
	const cleanedSettings = Object.keys(assetSettings).length > 0 ? assetSettings : {};
	await writeAssetSettings(projectRoot, cleanedSettings);

	// Regenerate all protected files to keep them in sync
	await regenerateProtectedFiles(projectRoot);

	// Trigger full reload so the preview picks up new asset settings
	const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
	await coordinatorStub.triggerUpdate({ type: 'full-reload', path: '/wrangler.jsonc', timestamp: Date.now(), isCSS: false });

	return {
		title: 'asset settings updated',
		metadata: { assetSettings: cleanedSettings, changes },
		output: `Updated asset settings:\n${changes.join('\n')}`,
	};
}
