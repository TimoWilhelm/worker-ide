import { describe, expect, it, vi } from 'vitest';

import { createBaseResolvedConfig } from './config/resolve-config';
import { PluginContainer, PluginHookError } from './plugin-container';

import type { Plugin, ResolvedConfig } from './types';

function makeConfig(): ResolvedConfig {
	return createBaseResolvedConfig({ command: 'serve', mode: 'development', root: '/project' });
}

function makeContainer(plugins: Plugin[]): PluginContainer {
	return PluginContainer.create({
		config: makeConfig(),
		plugins,
		parse: (code) => ({ code }),
	});
}

describe('PluginContainer.resolveId', () => {
	it('returns the first plugin that resolves a specifier', async () => {
		const container = makeContainer([
			{ name: 'skips', resolveId: () => {} },
			{ name: 'resolver', resolveId: (source) => `/resolved/${source}` },
			{ name: 'never-reached', resolveId: () => '/wrong' },
		]);

		const result = await container.resolveId('foo', undefined, { ssr: false, environment: 'client' });
		expect(result).toEqual({ id: '/resolved/foo', external: false, meta: {} });
	});

	it('honours enforce: pre ordering over declaration order', async () => {
		const container = makeContainer([
			{ name: 'normal', resolveId: () => '/normal' },
			{ name: 'pre', enforce: 'pre', resolveId: () => '/pre' },
		]);

		const result = await container.resolveId('x', undefined, { ssr: false, environment: 'client' });
		expect(result?.id).toBe('/pre');
	});

	it('propagates external + meta from object results', async () => {
		const container = makeContainer([{ name: 'ext', resolveId: () => ({ id: 'react', external: true, meta: { cdn: true } }) }]);

		const result = await container.resolveId('react', undefined, { ssr: false, environment: 'client' });
		expect(result).toEqual({ id: 'react', external: true, meta: { cdn: true } });
	});

	it('returns undefined when no plugin resolves', async () => {
		const container = makeContainer([{ name: 'noop', resolveId: () => false }]);
		const result = await container.resolveId('x', undefined, { ssr: false, environment: 'client' });
		expect(result).toBeUndefined();
	});

	it('skips the calling plugin when skipSelf is set via this.resolve', async () => {
		const seen: string[] = [];
		const container = makeContainer([
			{
				name: 'self',
				resolveId(source) {
					seen.push(`self:${source}`);
					if (source === 'entry') {
						// Re-enter resolution but skip ourselves to avoid recursion.
						return this.resolve(source, undefined, { skipSelf: true }).then((r) => r?.id ?? undefined);
					}
					return;
				},
			},
			{
				name: 'other',
				resolveId(source) {
					seen.push(`other:${source}`);
					return `/other/${source}`;
				},
			},
		]);

		const result = await container.resolveId('entry', undefined, { ssr: false, environment: 'client' });
		expect(result?.id).toBe('/other/entry');
		// 'self' must not resolve itself recursively for the same id.
		expect(seen.filter((entry) => entry === 'self:entry')).toHaveLength(1);
	});
});

describe('PluginContainer.load', () => {
	it('returns the first plugin that loads content', async () => {
		const container = makeContainer([
			{ name: 'miss', load: () => {} },
			{ name: 'hit', load: (id) => `export const id = ${JSON.stringify(id)};` },
		]);

		const result = await container.load('virtual:thing', 'client');
		expect(result?.code).toBe('export const id = "virtual:thing";');
	});
});

describe('PluginContainer.transform', () => {
	it('pipes code through every transform in order', async () => {
		const container = makeContainer([
			{ name: 'a', transform: (code) => `${code}\n// a` },
			{ name: 'b', transform: (code) => ({ code: `${code}\n// b` }) },
		]);

		const result = await container.transform('source', '/x.ts', 'client');
		expect(result.code).toBe('source\n// a\n// b');
	});

	it('skips plugins that return undefined', async () => {
		const container = makeContainer([
			{ name: 'a', transform: () => {} },
			{ name: 'b', transform: (code) => `${code}!` },
		]);
		const result = await container.transform('x', '/x.ts', 'client');
		expect(result.code).toBe('x!');
	});
});

describe('PluginContainer environment gating', () => {
	it('skips plugins whose applyToEnvironment returns false', async () => {
		const container = makeContainer([
			{
				name: 'rsc-only',
				applyToEnvironment: (environment) => environment.name === 'rsc',
				resolveId: () => '/rsc',
			},
			{ name: 'all', resolveId: () => '/all' },
		]);

		const clientResult = await container.resolveId('x', undefined, { ssr: false, environment: 'client' });
		expect(clientResult?.id).toBe('/all');

		const rscResult = await container.resolveId('x', undefined, { ssr: true, environment: 'rsc' });
		expect(rscResult?.id).toBe('/rsc');
	});
});

describe('PluginContainer.buildStart', () => {
	it('runs each buildStart hook exactly once', async () => {
		const hook = vi.fn();
		const container = makeContainer([{ name: 'a', buildStart: hook }]);
		await container.buildStart();
		await container.buildStart();
		expect(hook).toHaveBeenCalledTimes(1);
	});
});

describe('PluginContainer.transformIndexHtml', () => {
	it('applies string rewrites and injects tags', async () => {
		const container = makeContainer([
			{ name: 'rewrite', transformIndexHtml: (html) => html.replace('TITLE', 'Hello') },
			{
				name: 'inject',
				transformIndexHtml: () => [{ tag: 'script', attrs: { src: '/main.js', type: 'module' }, injectTo: 'head' }],
			},
		]);

		const out = await container.transformIndexHtml('<head><title>TITLE</title></head><body></body>', {
			path: '/',
			filename: 'index.html',
		});
		expect(out).toContain('<title>Hello</title>');
		expect(out).toContain('<script src="/main.js" type="module"></script>');
		expect(out.indexOf('<script')).toBeLessThan(out.indexOf('</head>'));
	});
});

describe('PluginContainer error surfacing', () => {
	it('wraps this.error with the originating plugin name', async () => {
		const container = makeContainer([
			{
				name: 'boom',
				load() {
					this.error('exploded');
				},
			},
		]);

		await expect(container.load('/x', 'client')).rejects.toBeInstanceOf(PluginHookError);
		await expect(container.load('/x', 'client')).rejects.toThrow('[boom]');
	});
});
