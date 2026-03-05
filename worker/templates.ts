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

// =============================================================================
// Request Inspector template
// =============================================================================

import requestInspectorGitignore from './fixtures/request-inspector/gitignore.txt?raw';
import requestInspectorIndexHtml from './fixtures/request-inspector/index.html?raw';
import requestInspectorAppTsx from './fixtures/request-inspector/src/app.tsx?raw';
import requestInspectorMainTsx from './fixtures/request-inspector/src/main.tsx?raw';
import requestInspectorStyleCss from './fixtures/request-inspector/src/style.css?raw';
import requestInspectorUtilitiesTs from './fixtures/request-inspector/src/utilities.ts?raw';
import requestInspectorMetaRaw from './fixtures/request-inspector/template.json?raw';
import requestInspectorTestUtilitiesTs from './fixtures/request-inspector/test/utilities.test.ts?raw';
import requestInspectorTsconfig from './fixtures/request-inspector/tsconfig.json?raw';
import requestInspectorWorkerIndexTs from './fixtures/request-inspector/worker/index.ts?raw';

import type { ProjectTemplateMeta } from '@shared/types';

// Re-export for convenience

// =============================================================================
// Template types
// =============================================================================

export interface ProjectTemplate extends ProjectTemplateMeta {
	/** Map of relative file paths to file contents */
	files: Record<string, string>;
	/** npm dependencies for the template */
	dependencies: Record<string, string>;
}

/**
 * Shape of each template's template.json file.
 * Contains display metadata and dependency information.
 */
interface TemplateManifest extends ProjectTemplateMeta {
	dependencies: Record<string, string>;
}

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
		dependencies: meta.dependencies,
	};
}

// =============================================================================
// Template definitions
// =============================================================================

const requestInspectorTemplate = defineTemplate(requestInspectorMetaRaw, {
	'tsconfig.json': requestInspectorTsconfig,
	'index.html': requestInspectorIndexHtml,
	'src/main.tsx': requestInspectorMainTsx,
	'src/app.tsx': requestInspectorAppTsx,
	'src/style.css': requestInspectorStyleCss,
	'src/utilities.ts': requestInspectorUtilitiesTs,
	'test/utilities.test.ts': requestInspectorTestUtilitiesTs,
	'worker/index.ts': requestInspectorWorkerIndexTs,
	'.gitignore': requestInspectorGitignore,
});

// =============================================================================
// Registry
// =============================================================================

/**
 * All available project templates.
 * The first template in the array is the default.
 */
export const TEMPLATES: ProjectTemplate[] = [requestInspectorTemplate];

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
 * Used by the GET /api/templates endpoint and the landing page.
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
