import { describe, expect, it } from 'vitest';

import { appendPreviewElementSegment, parseTextToSegments, segmentsHaveContent, segmentsToPlainText } from './input-segments';

import type { InputSegment } from './input-segments';

describe('segmentsToPlainText', () => {
	it('serializes text segments', () => {
		const segments: InputSegment[] = [{ type: 'text', value: 'Hello world' }];
		expect(segmentsToPlainText(segments)).toBe('Hello world');
	});

	it('serializes mention segments with @ prefix', () => {
		const segments: InputSegment[] = [{ type: 'mention', path: '/src/main.ts' }];
		expect(segmentsToPlainText(segments)).toBe('@/src/main.ts');
	});

	it('serializes mixed segments', () => {
		const segments: InputSegment[] = [
			{ type: 'text', value: 'Fix the bug in ' },
			{ type: 'mention', path: '/src/app.tsx' },
			{ type: 'text', value: ' please' },
		];
		expect(segmentsToPlainText(segments)).toBe('Fix the bug in @/src/app.tsx please');
	});

	it('serializes preview element segments', () => {
		const segments: InputSegment[] = [{ type: 'preview-element', selector: '#hero', tagName: 'div' }];
		expect(segmentsToPlainText(segments)).toBe('[[preview-element:<div>|%23hero]]');
	});

	it('returns empty string for empty segments', () => {
		expect(segmentsToPlainText([])).toBe('');
	});
});

describe('segmentsHaveContent', () => {
	it('returns true for non-empty text', () => {
		const segments: InputSegment[] = [{ type: 'text', value: 'hello' }];
		expect(segmentsHaveContent(segments)).toBe(true);
	});

	it('returns true for mention segments', () => {
		const segments: InputSegment[] = [{ type: 'mention', path: '/src/main.ts' }];
		expect(segmentsHaveContent(segments)).toBe(true);
	});

	it('returns false for empty segments', () => {
		expect(segmentsHaveContent([])).toBe(false);
	});

	it('returns false for whitespace-only text', () => {
		const segments: InputSegment[] = [{ type: 'text', value: '   \n\t  ' }];
		expect(segmentsHaveContent(segments)).toBe(false);
	});

	it('returns true when mention is mixed with whitespace text', () => {
		const segments: InputSegment[] = [
			{ type: 'text', value: '   ' },
			{ type: 'mention', path: '/src/main.ts' },
		];
		expect(segmentsHaveContent(segments)).toBe(true);
	});

	it('returns true for preview element segments', () => {
		const segments: InputSegment[] = [{ type: 'preview-element', selector: '#hero', tagName: 'section' }];
		expect(segmentsHaveContent(segments)).toBe(true);
	});
});

describe('parseTextToSegments', () => {
	it('parses plain text without mentions', () => {
		const knownPaths = new Set(['/src/main.ts']);
		const segments = parseTextToSegments('Hello world', knownPaths);
		expect(segments).toEqual([{ type: 'text', value: 'Hello world' }]);
	});

	it('parses a known file mention', () => {
		const knownPaths = new Set(['/src/main.ts']);
		const segments = parseTextToSegments('Fix @/src/main.ts please', knownPaths);
		expect(segments).toEqual([
			{ type: 'text', value: 'Fix ' },
			{ type: 'mention', path: '/src/main.ts' },
			{ type: 'text', value: ' please' },
		]);
	});

	it('ignores unknown file mentions', () => {
		const knownPaths = new Set(['/src/main.ts']);
		const segments = parseTextToSegments('Fix @/unknown/file.ts please', knownPaths);
		expect(segments).toEqual([{ type: 'text', value: 'Fix @/unknown/file.ts please' }]);
	});

	it('parses multiple mentions', () => {
		const knownPaths = new Set(['/src/main.ts', '/src/app.tsx']);
		const segments = parseTextToSegments('Compare @/src/main.ts and @/src/app.tsx', knownPaths);
		expect(segments).toEqual([
			{ type: 'text', value: 'Compare ' },
			{ type: 'mention', path: '/src/main.ts' },
			{ type: 'text', value: ' and ' },
			{ type: 'mention', path: '/src/app.tsx' },
		]);
	});

	it('handles text starting with a mention', () => {
		const knownPaths = new Set(['/src/main.ts']);
		const segments = parseTextToSegments('@/src/main.ts has a bug', knownPaths);
		expect(segments).toEqual([
			{ type: 'mention', path: '/src/main.ts' },
			{ type: 'text', value: ' has a bug' },
		]);
	});

	it('returns empty array for empty text', () => {
		const segments = parseTextToSegments('', new Set());
		expect(segments).toEqual([]);
	});

	it('parses preview element references', () => {
		const segments = parseTextToSegments('Inspect [[preview-element:<img>|.hero%20img]] please', new Set());
		expect(segments).toEqual([
			{ type: 'text', value: 'Inspect ' },
			{ type: 'preview-element', selector: '.hero img', tagName: 'img' },
			{ type: 'text', value: ' please' },
		]);
	});

	it('parses preview element references alongside file mentions', () => {
		const knownPaths = new Set(['/src/main.ts']);
		const segments = parseTextToSegments('Update [[preview-element:<button>|%23submit]] in @/src/main.ts', knownPaths);
		expect(segments).toEqual([
			{ type: 'text', value: 'Update ' },
			{ type: 'preview-element', selector: '#submit', tagName: 'button' },
			{ type: 'text', value: ' in ' },
			{ type: 'mention', path: '/src/main.ts' },
		]);
	});
});

describe('appendPreviewElementSegment', () => {
	it('appends a preview element with spacing for continued typing', () => {
		const segments = appendPreviewElementSegment([{ type: 'text', value: 'Inspect' }], { selector: '#hero', tagName: 'div' });
		expect(segments).toEqual([
			{ type: 'text', value: 'Inspect ' },
			{ type: 'preview-element', selector: '#hero', tagName: 'div' },
			{ type: 'text', value: ' ' },
		]);
	});
});
