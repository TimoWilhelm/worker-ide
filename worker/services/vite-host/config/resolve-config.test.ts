import { describe, expect, it, vi } from 'vitest';

import { resolveConfig } from './resolve-config';

import type { Plugin } from '../types';

const named = (name: string): Plugin => ({ name });

describe('resolveConfig', () => {
	it('runs config then configResolved in order', async () => {
		const calls: string[] = [];
		const plugin: Plugin = {
			name: 'p',
			config: () => {
				calls.push('config');
				return { base: '/app/' };
			},
			configResolved: (config) => {
				calls.push(`configResolved:${config.base}`);
			},
		};

		const { config } = await resolveConfig({ plugins: [plugin], command: 'serve', mode: 'development', root: '/project' });

		expect(calls).toEqual(['config', 'configResolved:/app/']);
		expect(config.base).toBe('/app/');
		expect(config.command).toBe('serve');
	});

	it('merges resolve.alias across plugins', async () => {
		const a: Plugin = { name: 'a', config: () => ({ resolve: { alias: { '@': '/src' } } }) };
		const b: Plugin = { name: 'b', config: () => ({ resolve: { alias: { '~': '/lib' } } }) };

		let observed: Record<string, string> | undefined;
		const observer: Plugin = {
			name: 'observer',
			configResolved: (config) => {
				observed = config.plugins.length > 0 ? { ok: 'yes' } : undefined;
			},
		};

		const { config } = await resolveConfig({ plugins: [a, b, observer], command: 'build', mode: 'production', root: '/p' });
		expect(observed).toEqual({ ok: 'yes' });
		expect(config.command).toBe('build');
	});

	it('flattens nested and conditional plugin arrays', async () => {
		const { plugins } = await resolveConfig({
			plugins: [named('a'), [named('b'), false, [named('c')]], undefined],
			command: 'serve',
			mode: 'development',
			root: '/p',
		});
		expect(plugins.map((plugin) => plugin.name)).toEqual(['a', 'b', 'c']);
	});

	it('awaits async config hooks', async () => {
		const hook = vi.fn(async () => ({ base: '/async/' }));
		const { config } = await resolveConfig({
			plugins: [{ name: 'async', config: hook }],
			command: 'serve',
			mode: 'development',
			root: '/p',
		});
		expect(hook).toHaveBeenCalledOnce();
		expect(config.base).toBe('/async/');
	});
});
