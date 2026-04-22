import { describe, expect, it } from 'vitest';

import {
	buildPreviewExternalModuleRequest,
	buildPreviewRequest,
	getPreviewUpdateTargets,
	isAllowedPreviewExternalModuleUrl,
	parsePreviewExternalModuleRequest,
	parsePreviewRequest,
	resolvePreviewPath,
	toAbsolutePreviewPath,
	toPreviewExternalModuleId,
	toPreviewModuleId,
	withPreviewTimestamp,
} from './preview-path';

describe('toAbsolutePreviewPath', () => {
	it('preserves absolute preview paths', () => {
		expect(toAbsolutePreviewPath('/src/style.css')).toBe('/src/style.css');
	});

	it('normalizes relative preview paths to absolute ones', () => {
		expect(toAbsolutePreviewPath('src/style.css')).toBe('/src/style.css');
	});

	it('returns the preview root for empty paths', () => {
		expect(toAbsolutePreviewPath('')).toBe('/');
	});

	it('removes search parameters and hashes while normalizing', () => {
		expect(toAbsolutePreviewPath('src/style.css?mode=module#hash')).toBe('/src/style.css');
	});
});

describe('parsePreviewRequest', () => {
	it('parses source requests by default', () => {
		expect(parsePreviewRequest('/src/main.tsx')).toEqual({
			path: '/src/main.tsx',
			mode: 'source',
			timestamp: undefined,
		});
	});

	it('parses explicit module requests', () => {
		expect(parsePreviewRequest('/src/style.css?mode=module&t=123')).toEqual({
			path: '/src/style.css',
			mode: 'module',
			timestamp: '123',
		});
	});
});

describe('buildPreviewRequest', () => {
	it('builds explicit module requests', () => {
		expect(buildPreviewRequest('/src/style.css', { mode: 'module' })).toBe('/src/style.css?mode=module');
	});

	it('appends timestamps without losing mode', () => {
		expect(withPreviewTimestamp('/src/style.css?mode=module', 42)).toBe('/src/style.css?mode=module&t=42');
	});
});

describe('external preview module requests', () => {
	it('builds same-origin proxy requests for bare package imports', () => {
		expect(buildPreviewExternalModuleRequest('react/jsx-runtime')).toBe(
			'/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%2Fjsx-runtime%3Fdev',
		);
	});

	it('forces the React dev build for versioned package entrypoints', () => {
		expect(buildPreviewExternalModuleRequest('react@19.2.0')).toBe('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%4019.2.0%3Fdev');
		expect(buildPreviewExternalModuleRequest('react-dom@19.2.0/client')).toBe(
			'/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact-dom%4019.2.0%2Fclient%3Fdev',
		);
	});

	it('resolves relative imports against the upstream external module url', () => {
		expect(
			buildPreviewExternalModuleRequest('./chunk-abc.mjs', {
				baseUrl: 'https://esm.sh/react-dom@19.1.0/es2022/client.mjs',
			}),
		).toBe('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact-dom%4019.1.0%2Fes2022%2Fchunk-abc.mjs');
	});

	it('keeps bare specifiers rooted at the external module origin', () => {
		expect(
			buildPreviewExternalModuleRequest('react', {
				baseUrl: 'https://esm.sh/react-dom@19.1.0/es2022/client.mjs',
			}),
		).toBe('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%3Fdev');
	});

	it('parses proxied external module requests', () => {
		expect(parsePreviewExternalModuleRequest('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact%3Fdev&t=123')).toEqual({
			externalUrl: 'https://esm.sh/react?dev',
			timestamp: '123',
		});
	});

	it('rejects non-https or non-esm external module requests', () => {
		expect(parsePreviewExternalModuleRequest('/__preview_external?url=http%3A%2F%2Fesm.sh%2Freact')).toBeUndefined();
		expect(parsePreviewExternalModuleRequest('/__preview_external?url=https%3A%2F%2Fexample.com%2Freact')).toBeUndefined();
	});

	it('uses timestamp-free requests as canonical external module ids', () => {
		expect(toPreviewExternalModuleId('react-dom/client')).toBe('/__preview_external?url=https%3A%2F%2Fesm.sh%2Freact-dom%2Fclient%3Fdev');
	});

	it('throws when building requests for disallowed external module urls', () => {
		expect(() => buildPreviewExternalModuleRequest('https://example.com/react.mjs')).toThrow('Unsupported external module URL');
		expect(() => buildPreviewExternalModuleRequest('http://esm.sh/react')).toThrow('Unsupported external module URL');
	});
});

describe('isAllowedPreviewExternalModuleUrl', () => {
	it('allows only plain https esm.sh urls', () => {
		expect(isAllowedPreviewExternalModuleUrl(new URL('https://esm.sh/react'))).toBe(true);
		expect(isAllowedPreviewExternalModuleUrl(new URL('https://esm.sh:444/react'))).toBe(false);
		expect(isAllowedPreviewExternalModuleUrl(new URL('https://user:pass@esm.sh/react'))).toBe(false);
		expect(isAllowedPreviewExternalModuleUrl(new URL('https://cdn.esm.sh/react'))).toBe(false);
	});
});

describe('resolvePreviewPath', () => {
	it('resolves relative paths from the importer directory', () => {
		expect(resolvePreviewPath('./style.css', '/src/main.tsx')).toBe('/src/style.css');
		expect(resolvePreviewPath('../lib/data.json', '/src/routes/page.tsx')).toBe('/src/lib/data.json');
	});
});

describe('toPreviewModuleId', () => {
	it('keeps javascript requests as source modules', () => {
		expect(toPreviewModuleId('/src/main.tsx')).toBe('/src/main.tsx');
	});

	it('wraps css imports as module requests', () => {
		expect(toPreviewModuleId('/src/style.css')).toBe('/src/style.css?mode=module');
	});

	it('wraps asset imports as url modules', () => {
		expect(toPreviewModuleId('/src/logo.png')).toBe('/src/logo.png?mode=url');
	});
});

describe('getPreviewUpdateTargets', () => {
	it('returns both linked and module css targets', () => {
		expect(getPreviewUpdateTargets('/src/style.css')).toEqual([
			{ id: '/src/style.css', kind: 'style-link' },
			{ id: '/src/style.css?mode=module', kind: 'module' },
		]);
	});

	it('returns module targets for javascript and assets', () => {
		expect(getPreviewUpdateTargets('/src/main.tsx')).toEqual([{ id: '/src/main.tsx', kind: 'module' }]);
		expect(getPreviewUpdateTargets('/src/data.json')).toEqual([{ id: '/src/data.json?mode=module', kind: 'module' }]);
		expect(getPreviewUpdateTargets('/src/logo.png')).toEqual([{ id: '/src/logo.png?mode=url', kind: 'module' }]);
	});
});
