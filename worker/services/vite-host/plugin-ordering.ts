/**
 * Plugin flattening and hook ordering, matching Rollup/Vite semantics.
 *
 * Vite resolves the plugin pipeline by `enforce`: `pre` plugins run first, then
 * plugins with no `enforce`, then `post` plugins. Within a single hook, an
 * individual plugin may further refine its position with an object-form
 * `{ handler, order: 'pre' | 'post' }`. We honour both.
 */
import type { Plugin, PluginOption } from './types';

/**
 * Synchronously flatten nested/conditional plugin arrays, dropping falsy
 * entries. Promise entries are not supported here — use {@link resolvePluginOptions}
 * when the plugin set may contain promises (e.g. vinext's RSC plugins).
 */
export function flattenPlugins(options: readonly PluginOption[]): Plugin[] {
	const result: Plugin[] = [];
	for (const option of options) {
		if (!option || option instanceof Promise) {
			continue;
		}
		if (Array.isArray(option)) {
			result.push(...flattenPlugins(option));
			continue;
		}
		result.push(option);
	}
	return result;
}

/**
 * Asynchronously resolve a plugin option tree into a flat `Plugin[]`, awaiting
 * promise entries and recursing into arrays — matching Vite's plugin
 * resolution, which lets a plugin (e.g. vinext) contribute a promise of further
 * plugins.
 */
export async function resolvePluginOptions(options: readonly PluginOption[]): Promise<Plugin[]> {
	const result: Plugin[] = [];
	for (const option of options) {
		const awaited = option instanceof Promise ? await option : option;
		if (!awaited) {
			continue;
		}
		if (Array.isArray(awaited)) {
			result.push(...(await resolvePluginOptions(awaited)));
			continue;
		}
		result.push(awaited);
	}
	return result;
}

type HookName =
	| 'resolveId'
	| 'load'
	| 'transform'
	| 'buildStart'
	| 'transformIndexHtml'
	| 'hotUpdate'
	| 'renderChunk'
	| 'generateBundle'
	| 'writeBundle'
	| 'buildEnd'
	| 'closeBundle';

function enforceRank(enforce: Plugin['enforce']): number {
	if (enforce === 'pre') {
		return 0;
	}
	if (enforce === 'post') {
		return 2;
	}
	return 1;
}

function hookOrderRank(plugin: Plugin, hook: HookName): number {
	const value = plugin[hook];
	if (value !== undefined && typeof value === 'object' && 'order' in value) {
		const order = value.order;
		if (order === 'pre') {
			return 0;
		}
		if (order === 'post') {
			return 2;
		}
	}
	return 1;
}

/**
 * Return the subset of plugins that implement `hook`, ordered by the combined
 * `enforce` (plugin-level) then per-hook `order` modifier. A stable sort keeps
 * the original plugin declaration order as the tiebreaker.
 */
export function sortPluginsByHookOrder(plugins: readonly Plugin[], hook: HookName): Plugin[] {
	const withIndex = plugins.map((plugin, index) => ({ plugin, index })).filter((entry) => entry.plugin[hook] !== undefined);

	withIndex.sort((left, right) => {
		const leftEnforce = enforceRank(left.plugin.enforce);
		const rightEnforce = enforceRank(right.plugin.enforce);
		if (leftEnforce !== rightEnforce) {
			return leftEnforce - rightEnforce;
		}
		const leftHook = hookOrderRank(left.plugin, hook);
		const rightHook = hookOrderRank(right.plugin, hook);
		if (leftHook !== rightHook) {
			return leftHook - rightHook;
		}
		return left.index - right.index;
	});

	return withIndex.map((entry) => entry.plugin);
}
