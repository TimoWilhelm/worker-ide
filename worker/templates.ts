/**
 * Project Template Registry
 *
 * Centralized registry of all available project templates/starters.
 * Each template defines its files, dependencies, and metadata.
 *
 * To add a new template:
 * 1. Create a fixture directory under worker/fixtures/<template-name>/
 * 2. Import the fixture files as raw strings below
 * 3. Add a new entry to the TEMPLATES array
 */

// =============================================================================
// Request Inspector template
// =============================================================================

import requestInspectorIndexHtml from './fixtures/example-project/index.html?raw';
import requestInspectorAppTsx from './fixtures/example-project/src/app.tsx?raw';
import requestInspectorMainTsx from './fixtures/example-project/src/main.tsx?raw';
import requestInspectorStyleCss from './fixtures/example-project/src/style.css?raw';
import requestInspectorTsconfig from './fixtures/example-project/tsconfig.json?raw';
import requestInspectorWorkerIndexTs from './fixtures/example-project/worker/index.ts?raw';

// =============================================================================
// Template types
// =============================================================================

export interface ProjectTemplate {
	/** Unique template identifier (kebab-case) */
	id: string;
	/** Human-readable template name */
	name: string;
	/** Short description of what the template demonstrates */
	description: string;
	/** Lucide icon name for display on the frontend */
	icon: string;
	/** Map of relative file paths to file contents */
	files: Record<string, string>;
	/** npm dependencies for the template */
	dependencies: Record<string, string>;
}

/**
 * Metadata-only type for the GET /api/templates response.
 * Excludes file contents to keep the response lightweight.
 */
export interface ProjectTemplateMeta {
	id: string;
	name: string;
	description: string;
	icon: string;
}

// =============================================================================
// Template definitions
// =============================================================================

const requestInspectorTemplate: ProjectTemplate = {
	id: 'request-inspector',
	name: 'Request Inspector',
	description: 'Inspect incoming HTTP request headers, geolocation, and connection info from a Cloudflare Worker.',
	icon: 'Search',
	files: {
		'tsconfig.json': requestInspectorTsconfig,
		'index.html': requestInspectorIndexHtml,
		'src/main.tsx': requestInspectorMainTsx,
		'src/app.tsx': requestInspectorAppTsx,
		'src/style.css': requestInspectorStyleCss,
		'worker/index.ts': requestInspectorWorkerIndexTs,
	},
	dependencies: {
		hono: '^4.0.0',
		react: '^19.0.0',
		'react-dom': '^19.0.0',
	},
};

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
 * Used by the GET /api/templates endpoint.
 */
export function getTemplateMetadata(): ProjectTemplateMeta[] {
	return TEMPLATES.map((template) => ({
		id: template.id,
		name: template.name,
		description: template.description,
		icon: template.icon,
	}));
}
