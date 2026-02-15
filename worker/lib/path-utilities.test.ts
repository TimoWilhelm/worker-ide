/**
 * Unit tests for worker path utilities.
 */

import { describe, expect, it } from 'vitest';

import { isPathSafe, isProtectedFile, getExtension, isBinaryFile } from './path-utilities';

// =============================================================================
// isPathSafe
// =============================================================================

describe('isPathSafe', () => {
	it('accepts valid absolute paths', () => {
		expect(isPathSafe('/root', '/src/main.ts')).toBe(true);
		expect(isPathSafe('/root', '/file.ts')).toBe(true);
		expect(isPathSafe('/root', '/a/b/c/d.tsx')).toBe(true);
	});

	it('rejects paths without leading slash', () => {
		expect(isPathSafe('/root', 'src/main.ts')).toBe(false);
	});

	it('rejects paths with ..', () => {
		expect(isPathSafe('/root', '/src/../etc/passwd')).toBe(false);
		expect(isPathSafe('/root', '/../secret')).toBe(false);
	});

	it('rejects paths with consecutive slashes', () => {
		expect(isPathSafe('/root', '/src//main.ts')).toBe(false);
	});

	it('accepts single slash root path', () => {
		expect(isPathSafe('/root', '/')).toBe(true);
	});
});

// =============================================================================
// isProtectedFile
// =============================================================================

describe('isProtectedFile', () => {
	it('returns true for protected files', () => {
		expect(isProtectedFile('/worker/index.ts')).toBe(true);
		expect(isProtectedFile('/worker/index.js')).toBe(true);
		expect(isProtectedFile('/tsconfig.json')).toBe(true);
		expect(isProtectedFile('/package.json')).toBe(true);
	});

	it('returns true for index.html', () => {
		expect(isProtectedFile('/index.html')).toBe(true);
	});

	it('returns false for non-protected files', () => {
		expect(isProtectedFile('/src/main.ts')).toBe(false);
		expect(isProtectedFile('/src/app.tsx')).toBe(false);
	});
});

// =============================================================================
// getExtension
// =============================================================================

describe('getExtension', () => {
	it('returns extension with dot', () => {
		expect(getExtension('/src/main.ts')).toBe('.ts');
		expect(getExtension('/styles/app.css')).toBe('.css');
	});

	it('returns lowercase extension', () => {
		expect(getExtension('/file.TSX')).toBe('.tsx');
		expect(getExtension('/file.JSON')).toBe('.json');
	});

	it('returns last extension for multiple dots', () => {
		expect(getExtension('/file.test.ts')).toBe('.ts');
		expect(getExtension('/archive.tar.gz')).toBe('.gz');
	});

	it('returns empty string for no extension', () => {
		expect(getExtension('/Makefile')).toBe('');
		expect(getExtension('/LICENSE')).toBe('');
	});
});

// =============================================================================
// isBinaryFile
// =============================================================================

describe('isBinaryFile', () => {
	it('returns true for binary extensions', () => {
		expect(isBinaryFile('/image.png')).toBe(true);
		expect(isBinaryFile('/image.jpg')).toBe(true);
		expect(isBinaryFile('/font.woff2')).toBe(true);
		expect(isBinaryFile('/archive.zip')).toBe(true);
		expect(isBinaryFile('/video.mp4')).toBe(true);
	});

	it('returns false for text extensions', () => {
		expect(isBinaryFile('/src/main.ts')).toBe(false);
		expect(isBinaryFile('/styles/app.css')).toBe(false);
		expect(isBinaryFile('/index.html')).toBe(false);
		expect(isBinaryFile('/data.json')).toBe(false);
	});

	it('returns false for files without extension', () => {
		expect(isBinaryFile('/Makefile')).toBe(false);
	});
});
