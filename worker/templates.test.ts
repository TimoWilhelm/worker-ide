/**
 * Unit tests for the project template registry.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TEMPLATE_ID, getTemplate, getTemplateMetadata, TEMPLATES } from './templates';

import type { ProjectTemplate, ProjectTemplateMeta } from './templates';

// =============================================================================
// TEMPLATES array
// =============================================================================

describe('TEMPLATES', () => {
	it('contains at least one template', () => {
		expect(TEMPLATES.length).toBeGreaterThanOrEqual(1);
	});

	it('has unique template IDs', () => {
		const ids = TEMPLATES.map((template) => template.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('every template has required fields', () => {
		for (const template of TEMPLATES) {
			expect(template.id).toBeTruthy();
			expect(template.name).toBeTruthy();
			expect(template.description).toBeTruthy();
			expect(template.icon).toBeTruthy();
			expect(Object.keys(template.files).length).toBeGreaterThan(0);
			expect(Object.keys(template.dependencies).length).toBeGreaterThan(0);
		}
	});

	it('every template ID is kebab-case', () => {
		for (const template of TEMPLATES) {
			expect(template.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
		}
	});

	it('every template file path is a relative path (no leading slash)', () => {
		for (const template of TEMPLATES) {
			for (const filePath of Object.keys(template.files)) {
				expect(filePath).not.toMatch(/^\//);
			}
		}
	});

	it('every template file content is a string', () => {
		for (const template of TEMPLATES) {
			for (const [filePath, content] of Object.entries(template.files)) {
				expect(typeof content, `File ${filePath} in template ${template.id} should be a string`).toBe('string');
			}
		}
	});
});

// =============================================================================
// DEFAULT_TEMPLATE_ID
// =============================================================================

describe('DEFAULT_TEMPLATE_ID', () => {
	it('is request-inspector', () => {
		expect(DEFAULT_TEMPLATE_ID).toBe('request-inspector');
	});

	it('refers to a template that exists in the registry', () => {
		const template = TEMPLATES.find((t) => t.id === DEFAULT_TEMPLATE_ID);
		expect(template).toBeDefined();
	});
});

// =============================================================================
// getTemplate
// =============================================================================

describe('getTemplate', () => {
	it('returns a template when given a valid ID', () => {
		const template = getTemplate('request-inspector');
		expect(template).toBeDefined();
		expect(template?.id).toBe('request-inspector');
	});

	it('returns the correct template shape', () => {
		const template = getTemplate('request-inspector');
		expect(template).toBeDefined();

		// Verify it satisfies ProjectTemplate interface shape
		const typed: ProjectTemplate = template!;
		expect(typed.id).toBe('request-inspector');
		expect(typed.name).toBe('Request Inspector');
		expect(typeof typed.description).toBe('string');
		expect(typeof typed.icon).toBe('string');
		expect(typeof typed.files).toBe('object');
		expect(typeof typed.dependencies).toBe('object');
	});

	it('returns undefined for an unknown template ID', () => {
		const template = getTemplate('nonexistent-template');
		expect(template).toBeUndefined();
	});

	it('returns undefined for an empty string', () => {
		const template = getTemplate('');
		expect(template).toBeUndefined();
	});

	it('is case-sensitive', () => {
		const template = getTemplate('Request-Inspector');
		expect(template).toBeUndefined();
	});
});

// =============================================================================
// getTemplateMetadata
// =============================================================================

describe('getTemplateMetadata', () => {
	it('returns an array of metadata for all templates', () => {
		const metadata = getTemplateMetadata();
		expect(metadata).toHaveLength(TEMPLATES.length);
	});

	it('returns metadata without file contents', () => {
		const metadata = getTemplateMetadata();
		for (const meta of metadata) {
			expect(meta).not.toHaveProperty('files');
			expect(meta).not.toHaveProperty('dependencies');
		}
	});

	it('includes all required metadata fields', () => {
		const metadata = getTemplateMetadata();
		for (const meta of metadata) {
			const typed: ProjectTemplateMeta = meta;
			expect(typed.id).toBeTruthy();
			expect(typed.name).toBeTruthy();
			expect(typed.description).toBeTruthy();
			expect(typed.icon).toBeTruthy();
		}
	});

	it('preserves the order of templates', () => {
		const metadata = getTemplateMetadata();
		for (const [index, meta] of metadata.entries()) {
			expect(meta.id).toBe(TEMPLATES[index].id);
		}
	});

	it('returns metadata matching the source templates', () => {
		const metadata = getTemplateMetadata();
		for (const [index, meta] of metadata.entries()) {
			const source = TEMPLATES[index];
			expect(meta.id).toBe(source.id);
			expect(meta.name).toBe(source.name);
			expect(meta.description).toBe(source.description);
			expect(meta.icon).toBe(source.icon);
		}
	});
});
