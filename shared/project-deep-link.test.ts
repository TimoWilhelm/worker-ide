import { describe, expect, it } from 'vitest';

import {
	buildProjectDeepLinkPath,
	isProjectDeepLinkTarget,
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
	});

	it('parses project deep-link query parameters', () => {
		expect(parseProjectDeepLink(new URLSearchParams('session=session-7'))).toEqual({ kind: 'agent-session', sessionId: 'session-7' });

		expect(parseProjectDeepLink(new URLSearchParams('file=src%2Fmain.ts&line=12'))).toEqual({
			kind: 'file',
			file: {
				path: 'src/main.ts',
				line: 12,
			},
		});

		expect(parseProjectDeepLink(new URLSearchParams('panel=preview'))).toEqual({ kind: 'panel', panel: 'preview' });
	});

	it('returns undefined when no supported deep-link params exist', () => {
		expect(parseProjectDeepLink(new URLSearchParams('foo=bar'))).toBeUndefined();
	});

	it('validates runtime deep-link target payloads', () => {
		expect(isProjectDeepLinkTarget({ kind: 'panel', panel: 'preview' })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'file', file: { path: '/src/app.ts', line: 4 } })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'agent-session', sessionId: 'session-2' })).toBe(true);
		expect(isProjectDeepLinkTarget({ kind: 'file', file: { line: 4 } })).toBe(false);
	});
});
