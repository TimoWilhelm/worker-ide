/**
 * Config resolution for the Vite Surface Host.
 *
 * Takes the flat plugin set a project's `vite.config` produces, runs the Vite
 * `config` → `configResolved` lifecycle, and yields the {@link ResolvedConfig}
 * plus the ordered plugins ready for a {@link PluginContainer}.
 *
 * The host does not execute a literal `vite.config.ts` file here; instead the
 * caller supplies the resolved plugin list (vinext + plugin-rsc + plugin-react,
 * already instantiated from the vendored bundle) together with the base user
 * config. This keeps config evaluation deterministic and side-effect free.
 */
import { normalizePosixPath } from '../node-fs/memory-file-system';
import { getProjectFileSystem } from '../node-fs/node-fs-bridge';
import { resolvePluginOptions } from '../plugin-ordering';

const RESOLVER_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.json'];

/**
 * A lazy id resolver matching the shape Vite's `config.createResolver()`
 * returns. Relative/absolute ids are probed against the project filesystem;
 * bare specifiers are returned unchanged for downstream handling.
 */
async function resolveProjectId(id: string, importer?: string): Promise<string | undefined> {
	if (!id.startsWith('.') && !id.startsWith('/')) {
		return id;
	}
	let fileSystem;
	try {
		fileSystem = getProjectFileSystem();
	} catch {
		return;
	}
	const importerDirectory = importer === undefined ? '/' : importer.slice(0, Math.max(0, importer.lastIndexOf('/'))) || '/';
	const base = normalizePosixPath(id.startsWith('/') ? id : `${importerDirectory}/${id}`);
	if (fileSystem.exists(base) && fileSystem.stat(base).isFile()) {
		return base;
	}
	for (const extension of RESOLVER_EXTENSIONS) {
		if (fileSystem.exists(base + extension)) {
			return base + extension;
		}
	}
	return;
}

function createDefaultResolver(): (id: string, importer?: string) => Promise<string | undefined> {
	return resolveProjectId;
}

import type { ConfigEnvironment, Plugin, PluginOption, ResolvedConfig, UserConfig, ViteCommand, ViteLogger } from '../types';

function createSilentLogger(): ViteLogger {
	return {
		info: () => {},
		warn: () => {},
		warnOnce: () => {},
		error: () => {},
		hasWarned: false,
	};
}

export interface BaseResolvedConfigInput {
	command: ViteCommand;
	mode: string;
	root: string;
	base?: string;
	env?: Record<string, string>;
	plugins?: readonly Plugin[];
	environments?: Record<string, import('../types').EnvironmentConfig>;
	resolveAlias?: import('../types').AliasConfig;
}

/** A resolved per-environment config, mirroring Vite's Environment API shape. */
function createEnvironmentConfig(name: string, consumer: 'client' | 'server'): import('../types').EnvironmentConfig {
	return {
		consumer,
		build: {
			outDir: `dist/${name}`,
			assetsDir: 'assets',
			sourcemap: false,
			target: 'es2022',
			emptyOutDir: true,
			rollupOptions: {},
			lib: false,
		},
		resolve: {
			external: [],
			noExternal: [],
			conditions: consumer === 'server' ? ['workerd', 'module', 'node'] : ['module', 'browser', 'import'],
			dedupe: [],
			alias: [],
		},
		optimizeDeps: { include: [], exclude: [], esbuildOptions: {} },
		dev: { moduleRunnerTransform: false },
		keepProcessEnv: false,
	};
}

type EnvironmentMap = Record<string, import('../types').EnvironmentConfig>;
type SingleEnvironmentConfig = import('../types').EnvironmentConfig;

/**
 * Deep-merge two environment configs, preserving nested `build.rollupOptions`
 * (notably `input`). Vite deep-merges these across plugin `config` hooks; a
 * shallow merge would drop a plugin-set entry input when a later plugin
 * contributes other fields for the same environment.
 */
function mergeEnvironmentConfig(
	base: SingleEnvironmentConfig | undefined,
	override: SingleEnvironmentConfig | undefined,
): SingleEnvironmentConfig {
	const baseConfig = base ?? {};
	const overrideConfig = override ?? {};
	return {
		...baseConfig,
		...overrideConfig,
		build: {
			...baseConfig.build,
			...overrideConfig.build,
			rollupOptions: {
				...baseConfig.build?.rollupOptions,
				...overrideConfig.build?.rollupOptions,
				input: overrideConfig.build?.rollupOptions?.input ?? baseConfig.build?.rollupOptions?.input,
			},
		},
		resolve: { ...baseConfig.resolve, ...overrideConfig.resolve },
		optimizeDeps: { ...baseConfig.optimizeDeps, ...overrideConfig.optimizeDeps },
	};
}

/**
 * Normalise `resolve.alias` to Vite's resolved array form
 * (`[{ find, replacement }]`). Plugins read the array shape in `configResolved`
 * (e.g. iterating `alias.entries()`), so the object form a plugin may supply via
 * its `config` hook must be converted.
 */
function normalizeAlias(alias: import('../types').AliasConfig | undefined): Array<{ find: string | RegExp; replacement: string }> {
	if (alias === undefined) {
		return [];
	}
	if (Array.isArray(alias)) {
		return alias;
	}
	return Object.entries(alias).map(([find, replacement]) => ({ find, replacement }));
}

/**
 * Deep-merge environment overrides onto seeded defaults so every environment
 * retains a full `build`/`resolve`/`optimizeDeps` shape even when a plugin
 * contributes a partial entry (Vite resolves these deeply; a shallow merge would
 * drop required fields like `build.outDir`).
 */
function mergeEnvironments(defaults: EnvironmentMap, overrides: EnvironmentMap | undefined): EnvironmentMap {
	const result: EnvironmentMap = { ...defaults };
	for (const [name, override] of Object.entries(overrides ?? {})) {
		const base = result[name] ?? createEnvironmentConfig(name, name === 'client' ? 'client' : 'server');
		result[name] = mergeEnvironmentConfig(base, override);
	}
	return result;
}

/** Build a Vite-shaped {@link ResolvedConfig} with sensible host defaults. */
export function createBaseResolvedConfig(input: BaseResolvedConfigInput): ResolvedConfig {
	const root = input.root.replace(/\/$/, '');
	return {
		command: input.command,
		mode: input.mode,
		root: input.root,
		base: input.base ?? '/',
		isProduction: input.command === 'build',
		publicDir: `${root}/public`,
		cacheDir: `${root}/node_modules/.vite`,
		env: input.env ?? {},
		define: {},
		server: { hmr: {}, middlewareMode: false },
		build: { sourcemap: false, assetsDir: 'assets', target: 'es2022', outDir: 'dist', rollupOptions: {} },
		dev: { moduleRunnerTransform: false },
		resolve: {
			alias: normalizeAlias(input.resolveAlias),
			extensions: ['.mjs', '.js', '.mts', '.ts', '.jsx', '.tsx', '.json'],
			conditions: ['workerd', 'module', 'browser', 'import'],
			dedupe: [],
		},
		optimizeDeps: { include: [], exclude: [], esbuildOptions: {} },
		ssr: { external: [], noExternal: [], target: 'webworker' },
		worker: { format: 'es', plugins: () => [] },
		css: {},
		esbuild: {},
		experimental: {},
		environments: mergeEnvironments(
			{
				client: createEnvironmentConfig('client', 'client'),
				ssr: createEnvironmentConfig('ssr', 'server'),
				rsc: createEnvironmentConfig('rsc', 'server'),
			},
			input.environments,
		),
		logger: createSilentLogger(),
		assetsInclude: () => false,
		createResolver: () => createDefaultResolver(),
		plugins: input.plugins ?? [],
	};
}

export interface ResolveConfigInput {
	plugins: PluginOption[];
	command: ViteCommand;
	mode: string;
	root: string;
	base?: string;
	env?: Record<string, string>;
	/** Base user config plugins merge into (mirrors `vite.config` export). */
	userConfig?: UserConfig;
}

export interface ResolvedConfigResult {
	config: ResolvedConfig;
	plugins: Plugin[];
}

function isThenable(value: unknown): value is Promise<unknown> {
	return typeof value === 'object' && value !== null && 'then' in value && typeof Reflect.get(value, 'then') === 'function';
}

/** Shallow-merge a plugin's `config` hook return into the accumulating config. */
function mergeUserConfig(target: UserConfig, patch: UserConfig | undefined | void): UserConfig {
	if (patch === undefined || patch === null) {
		return target;
	}
	const merged: UserConfig = { ...target, ...patch };
	if (target.resolve !== undefined || patch.resolve !== undefined) {
		merged.resolve = {
			...target.resolve,
			...patch.resolve,
			alias: { ...target.resolve?.alias, ...patch.resolve?.alias },
		};
	}
	if (target.environments !== undefined || patch.environments !== undefined) {
		const names = new Set([...Object.keys(target.environments ?? {}), ...Object.keys(patch.environments ?? {})]);
		const environments: EnvironmentMap = {};
		for (const name of names) {
			environments[name] = mergeEnvironmentConfig(target.environments?.[name], patch.environments?.[name]);
		}
		merged.environments = environments;
	}
	return merged;
}

function unwrapConfigHook(
	plugin: Plugin,
):
	| ((config: UserConfig, environment: ConfigEnvironment) => UserConfig | undefined | void | Promise<UserConfig | undefined | void>)
	| undefined {
	const hook = plugin.config;
	if (hook === undefined) {
		return undefined;
	}
	return typeof hook === 'function' ? hook : hook.handler;
}

/** Whether a plugin's `apply` gate matches the current command. */
function pluginAppliesToCommand(plugin: Plugin, userConfig: UserConfig, environment: ConfigEnvironment): boolean {
	const apply = plugin.apply;
	if (apply === undefined) {
		return true;
	}
	if (typeof apply === 'function') {
		return apply(userConfig, environment);
	}
	return apply === environment.command;
}

function unwrapConfigResolvedHook(plugin: Plugin): ((config: ResolvedConfig) => void | Promise<void>) | undefined {
	const hook = plugin.configResolved;
	if (hook === undefined) {
		return undefined;
	}
	return typeof hook === 'function' ? hook : hook.handler;
}

/**
 * Run `config`/`configResolved` and produce the resolved config + ordered
 * plugins. Plugins are flattened (including any added via `config` hooks).
 */
export async function resolveConfig(input: ResolveConfigInput): Promise<ResolvedConfigResult> {
	const environment: ConfigEnvironment = { command: input.command, mode: input.mode };
	let userConfig: UserConfig = { ...input.userConfig, plugins: input.plugins };
	let plugins = await resolvePluginOptions(input.plugins);

	// `config` hooks may mutate config and contribute additional plugins.
	for (const plugin of plugins) {
		const hook = unwrapConfigHook(plugin);
		if (hook === undefined) {
			continue;
		}
		const result = hook(userConfig, environment);
		const patch = isThenable(result) ? await result : result;
		userConfig = mergeUserConfig(userConfig, patch ?? undefined);
	}

	// Re-resolve in case `config` hooks added plugins.
	if (userConfig.plugins !== undefined) {
		plugins = await resolvePluginOptions(userConfig.plugins);
	}

	// Filter by `apply`: Vite only includes plugins whose `apply` matches the
	// command. Dev-only (`apply: 'serve'`) plugins — e.g. plugin-rsc's
	// reference-validation, which emits `@id/` dev module ids — must not run in a
	// production build, and vice versa.
	plugins = plugins.filter((plugin) => pluginAppliesToCommand(plugin, userConfig, environment));

	const resolved = createBaseResolvedConfig({
		command: input.command,
		mode: input.mode,
		root: input.root,
		base: userConfig.base ?? input.base ?? '/',
		env: input.env ?? {},
		plugins,
		environments: userConfig.environments,
		resolveAlias: userConfig.resolve?.alias,
	});

	for (const plugin of plugins) {
		const hook = unwrapConfigResolvedHook(plugin);
		if (hook === undefined) {
			continue;
		}
		await hook(resolved);
	}

	return { config: resolved, plugins };
}
