import { describe, expect, it } from 'vitest';

import {
	clearProjectDeepLinkSearchParameters,
	buildProjectDeepLinkPath,
	isProjectDeepLinkTarget,
	normalizeProjectDeepLinkFilePath,
	parseProjectDeepLink,
	serializeProjectDeepLinkTarget,
} from './project-deep-link';

describe('project deep links', () => {
	it('builds canonical project session links', () => {
		expect(buildProjectDeepLinkPath('project-1', { kind: 'agent-session', sessionId: 'session-42' })).toBe(
			'/p/project-1?session=session-42',
		);
	});

	it('serializes file and panel deep links', () => {
		expect(serializeProjectDeepLinkTarget({ kind: 'file', file: { path: '/src/app.ts', line: 7, column: 2 } })).toBe(
			'file=%2Fsrc%2Fapp.ts&line=7&column=2',
		);
		expect(serializeProjectDeepLinkTarget({ kind: 'panel', panel: 'preview' })).toBe('panel=preview');
		expect(serializeProjectDeepLinkTarget({ kind: 'panel', panel: 'dependencies' })).toBe('panel=dependencies');
	});

	it('parses project deep-link query parameters', () => {
		expect(parseProjectDeepLink(new URLSearchParams('session=session-7'))).toEqual({ kind: 'agent-session', sessionId: 'session-7' });

		expect(parseProjectDeepLink(new URLSearchParams('file=src%2Fmain.ts&line=12'))).toEqual({
			kind: 'file',
			file: {
				path: '/src/main.ts',
				line: 12,
			},
		});

		expect(parseProjectDeepLink(new URLSearchParams('panel=preview'))).toEqual({ kind: 'panel', panel: 'preview' });
		expect(parseProjectDeepLink(new URLSearchParams('panel=dependencies'))).toEqual({ kind: 'panel', panel: 'dependencies' });
	});

	it('normalizes file paths when parsing and serializing file deep links', () => {
		expect(normalizeProjectDeepLinkFilePath('//src//app.tsx')).toBe('/src/app.tsx');
		expect(parseProjectDeepLink(new URLSearchParams('file=%2F%2Fsrc%2F%2Fapp.tsx&line=7'))).toEqual({
			kind: 'file',
			file: {
				path: '/src/app.tsx',
				line: 7,
			},
		});
		expect(serializeProjectDeepLinkTarget({ kind: 'file', file: { path: '//src//app.tsx', line: 7 } })).toBe(
			'file=%2Fsrc%2Fapp.tsx&line=7',
		);
	});

	it('returns undefined when no supported deep-link params exist', () => {
		expect(parseProjectDeepLink(new URLSearchParams('foo=bar'))).toBeUndefined();
	});

	it('clears consumed deep-link query parameters while preserving unrelated search parameters', () => {
		expect(clearProjectDeepLinkSearchParameters(new URLSearchParams('file=%2Fsrc%2Fapp.tsx&line=7&foo=bar')).toString()).toBe('foo=bar');
	});

	it('validates runtime deep-link target payloads', () => {
		expect(isProjectDeepLinkTarget({ kind: 'panel', panel: 'preview' })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'panel', panel: 'dependencies' })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'file', file: { path: '/src/app.ts', line: 4 } })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'agent-session', sessionId: 'session-2' })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'file', file: { line: 4 } })).toBe(false);
	});
});
