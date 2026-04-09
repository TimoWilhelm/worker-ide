/**
 * Project Template Registry
 *
 * Centralized registry of all available project templates/starters.
 * Each template lives in its own directory under worker/fixtures/<template-id>/
 * with a template.json file containing metadata (name, description, icon, dependencies).
 *
 * To add a new template:
 * 1. Create a fixture directory under worker/fixtures/<template-id>/
 * 2. Add a template.json with { id, name, description, icon, dependencies }
 * 3. Import the fixture files as raw strings below
 * 4. Add a new entry to the TEMPLATES array using defineTemplate()
 */

import minimalGitignore from './fixtures/minimal/gitignore.txt?raw';
import minimalIndexHtml from './fixtures/minimal/index.html?raw';
import minimalPackageJson from './fixtures/minimal/package.json?raw';
import minimalAppTsx from './fixtures/minimal/src/app.tsx?raw';
import minimalMainTsx from './fixtures/minimal/src/main.tsx?raw';
import minimalStyleCss from './fixtures/minimal/src/style.css?raw';
import minimalUtilitiesTs from './fixtures/minimal/src/utilities.ts?raw';
import minimalMetaRaw from './fixtures/minimal/template.json?raw';
import minimalTestUtilitiesTs from './fixtures/minimal/test/utilities.test.ts?raw';
import minimalTsconfigApp from './fixtures/minimal/tsconfig.app.json?raw';
import minimalTsconfig from './fixtures/minimal/tsconfig.json?raw';
import minimalTsconfigWorker from './fixtures/minimal/tsconfig.worker.json?raw';
import minimalViteConfig from './fixtures/minimal/vite.config.ts?raw';
import minimalVitestConfig from './fixtures/minimal/vitest.config.ts?raw';
import minimalWorkerIndexTs from './fixtures/minimal/worker/index.ts?raw';
import minimalWorkerEnvironmentDts from './fixtures/minimal/worker-env.d.ts?raw';
import minimalWranglerJsonc from './fixtures/minimal/wrangler.jsonc?raw';
import requestInspectorGitignore from './fixtures/request-inspector/gitignore.txt?raw';
import requestInspectorIndexHtml from './fixtures/request-inspector/index.html?raw';
import requestInspectorPackageJson from './fixtures/request-inspector/package.json?raw';
import requestInspectorAppTsx from './fixtures/request-inspector/src/app.tsx?raw';
import requestInspectorMainTsx from './fixtures/request-inspector/src/main.tsx?raw';
import requestInspectorStyleCss from './fixtures/request-inspector/src/style.css?raw';
import requestInspectorUtilitiesTs from './fixtures/request-inspector/src/utilities.ts?raw';
import requestInspectorMetaRaw from './fixtures/request-inspector/template.json?raw';
import requestInspectorTestUtilitiesTs from './fixtures/request-inspector/test/utilities.test.ts?raw';
import requestInspectorTsconfigApp from './fixtures/request-inspector/tsconfig.app.json?raw';
import requestInspectorTsconfig from './fixtures/request-inspector/tsconfig.json?raw';
import requestInspectorTsconfigWorker from './fixtures/request-inspector/tsconfig.worker.json?raw';
import requestInspectorViteConfig from './fixtures/request-inspector/vite.config.ts?raw';
import requestInspectorVitestConfig from './fixtures/request-inspector/vitest.config.ts?raw';
import requestInspectorWorkerIndexTs from './fixtures/request-inspector/worker/index.ts?raw';
import requestInspectorWorkerEnvironmentDts from './fixtures/request-inspector/worker-env.d.ts?raw';
import requestInspectorWranglerJsonc from './fixtures/request-inspector/wrangler.jsonc?raw';

import type { ProjectTemplateMeta } from '@shared/types';

// Re-export for convenience

// =============================================================================
// Template types
// =============================================================================

export interface ProjectTemplate extends ProjectTemplateMeta {
	/** Map of relative file paths to file contents */
	files: Record<string, string>;
}

/**
 * Shape of each template's template.json file.
 * Contains display metadata.
 */
type TemplateManifest = ProjectTemplateMeta;

// =============================================================================
// Helper
// =============================================================================

/**
 * Parse a raw JSON string from a template.json import and combine it
 * with a file map to produce a full ProjectTemplate.
 */
function defineTemplate(metaRaw: string, files: Record<string, string>): ProjectTemplate {
	const meta: TemplateManifest = JSON.parse(metaRaw);
	return {
		id: meta.id,
		name: meta.name,
		description: meta.description,
		icon: meta.icon,
		files,
	};
}

// =============================================================================
// Template definitions
// =============================================================================

const minimalTemplate = defineTemplate(minimalMetaRaw, {
	'package.json': minimalPackageJson,
	'wrangler.jsonc': minimalWranglerJsonc,
	'vite.config.ts': minimalViteConfig,
	'vitest.config.ts': minimalVitestConfig,
	'tsconfig.json': minimalTsconfig,
	'tsconfig.app.json': minimalTsconfigApp,
	'tsconfig.worker.json': minimalTsconfigWorker,
	'index.html': minimalIndexHtml,
	'src/main.tsx': minimalMainTsx,
	'src/app.tsx': minimalAppTsx,
	'src/style.css': minimalStyleCss,
	'src/utilities.ts': minimalUtilitiesTs,
	'test/utilities.test.ts': minimalTestUtilitiesTs,
	'worker/index.ts': minimalWorkerIndexTs,
	'worker-env.d.ts': minimalWorkerEnvironmentDts,
	'.gitignore': minimalGitignore,
});

const requestInspectorTemplate = defineTemplate(requestInspectorMetaRaw, {
	'package.json': requestInspectorPackageJson,
	'wrangler.jsonc': requestInspectorWranglerJsonc,
	'vite.config.ts': requestInspectorViteConfig,
	'vitest.config.ts': requestInspectorVitestConfig,
	'tsconfig.json': requestInspectorTsconfig,
	'tsconfig.app.json': requestInspectorTsconfigApp,
	'tsconfig.worker.json': requestInspectorTsconfigWorker,
	'index.html': requestInspectorIndexHtml,
	'src/main.tsx': requestInspectorMainTsx,
	'src/app.tsx': requestInspectorAppTsx,
	'src/style.css': requestInspectorStyleCss,
	'src/utilities.ts': requestInspectorUtilitiesTs,
	'test/utilities.test.ts': requestInspectorTestUtilitiesTs,
	'worker/index.ts': requestInspectorWorkerIndexTs,
	'worker-env.d.ts': requestInspectorWorkerEnvironmentDts,
	'.gitignore': requestInspectorGitignore,
});

// =============================================================================
// Registry
// =============================================================================

/**
 * All available project templates.
 * The first template in the array is the default.
 */
export const TEMPLATES: ProjectTemplate[] = [requestInspectorTemplate, minimalTemplate];

/** The default template used when no template is specified */
export const DEFAULT_TEMPLATE_ID = 'request-inspector';

/**
 * Look up a template by its ID.
 * Returns undefined if the template is not found.
 */
export function getTemplate(templateId: string): ProjectTemplate | undefined {
	return TEMPLATES.find((template) => template.id === templateId);
}

/**
 * Get metadata for all templates (without file contents).
 * Used by the GET /api/templates endpoint and the dashboard page.
 */
export function getTemplateMetadata(): ProjectTemplateMeta[] {
	return TEMPLATES.map((template) => ({
		id: template.id,
		name: template.name,
		description: template.description,
		icon: template.icon,
	}));
}

export { type ProjectTemplateMeta } from '@shared/types';
