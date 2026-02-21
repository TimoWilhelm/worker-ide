/**
 * Biome Linter Service Tests
 */

import { describe, expect, it } from 'vitest';

import { isLintableFile } from './biome-linter';

// =============================================================================
// isLintableFile
// =============================================================================

describe('isLintableFile', () => {
	it('returns true for TypeScript files', () => {
		expect(isLintableFile('/src/app.ts')).toBe(true);
		expect(isLintableFile('/src/app.tsx')).toBe(true);
	});

	it('returns true for JavaScript files', () => {
		expect(isLintableFile('/src/app.js')).toBe(true);
		expect(isLintableFile('/src/app.jsx')).toBe(true);
		expect(isLintableFile('/src/app.mjs')).toBe(true);
	});

	it('returns true for CSS files', () => {
		expect(isLintableFile('/src/styles.css')).toBe(true);
	});

	it('returns true for JSON files', () => {
		expect(isLintableFile('/tsconfig.json')).toBe(true);
	});

	it('returns false for unsupported file types', () => {
		expect(isLintableFile('/README.md')).toBe(false);
		expect(isLintableFile('/image.png')).toBe(false);
		expect(isLintableFile('/data.txt')).toBe(false);
		expect(isLintableFile('/index.html')).toBe(false);
		expect(isLintableFile('/font.woff2')).toBe(false);
	});
});
