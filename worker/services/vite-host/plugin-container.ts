/**
 * Plugin container — the heart of the Vite Surface Host.
 *
 * Drives the Rollup/Vite hook lifecycle (`buildStart` → `resolveId` → `load` →
 * `transform` → `transformIndexHtml` → `hotUpdate`) over an ordered plugin set,
 * supplying each hook a faithful {@link PluginContext}. It is environment-aware:
 * the same container resolves/loads/transforms differently for the `client`,
 * `ssr`, and `rsc` environments, which `@vitejs/plugin-rsc` and `vinext` depend
 * on.
 *
 * The container is pure orchestration: it performs no bundling itself. Actual
 * code generation (esbuild transforms, CDN resolution) is delegated by plugins
 * via their hooks, keeping this module testable in isolation.
 */
import { matchesHookFilter } from './hook-filter';
import { flattenPlugins, sortPluginsByHookOrder } from './plugin-ordering';

import type { HookFilter } from './hook-filter';
import type {
	EmittedFile,
	HookOrder,
	HostEnvironment,
	HotUpdateContext,
	IndexHtmlTransformContext,
	ModuleInfo,
	ModuleTransformResult,
	NormalizedOutputOptions,
	ObjectHook,
	OutputBundle,
	OutputChunk,
	Plugin,
	PluginContext,
	PluginOption,
	ResolveIdOptions,
	ResolvedConfig,
	ViteEnvironmentName,
} from './types';

export interface ResolveResult {
	id: string;
	external: boolean;
	meta: Record<string, unknown>;
}

export interface LoadOutput {
	code: string;
	map?: ModuleTransformResult['map'];
	meta: Record<string, unknown>;
}

export interface TransformOutput {
	code: string;
	map?: ModuleTransformResult['map'];
	meta: Record<string, unknown>;
}

/** Sink for files emitted by plugins (`this.emitFile`). */
export interface EmittedFileSink {
	emit(file: EmittedFile, environment: ViteEnvironmentName): string;
	getFileName(referenceId: string): string;
}

/** Parser used by `this.parse`; injected so the container stays runtime-agnostic. */
export type AstParser = (code: string, options?: unknown) => unknown;

export interface PluginContainerOptions {
	config: ResolvedConfig;
	plugins: readonly Plugin[];
	parse: AstParser;
	emittedFileSink?: EmittedFileSink;
	onWarn?: (warning: string) => void;
	onWatchFile?: (id: string, environment: ViteEnvironmentName) => void;
}

/**
 * A thrown plugin error carrying the originating plugin name so the host can
 * surface actionable diagnostics in the preview error overlay.
 */
export class PluginHookError extends Error {
	constructor(
		message: string,
		readonly pluginName: string,
		readonly hook: string,
	) {
		super(`[${pluginName}] ${hook}: ${message}`);
		this.name = 'PluginHookError';
	}
}

interface OrderedPlugins {
	resolveId: Plugin[];
	load: Plugin[];
	transform: Plugin[];
	buildStart: Plugin[];
	transformIndexHtml: Plugin[];
	hotUpdate: Plugin[];
	renderChunk: Plugin[];
	generateBundle: Plugin[];
	writeBundle: Plugin[];
	buildEnd: Plugin[];
	closeBundle: Plugin[];
}

type AnyHookHandler = (...arguments_: never[]) => unknown;

/**
 * Fallback resolution used by a plugin's `this.resolve` when no plugin handles
 * the specifier — mirrors Rollup's default resolver so `this.resolve` returns a
 * concrete result (not `undefined`). Supplied by the esbuild bridge per build.
 */
export type DefaultResolve = (
	source: string,
	importer: string | undefined,
	environment: ViteEnvironmentName,
) => { id: string; external: boolean } | undefined;

/** Normalise an object-or-bare hook into `{ handler, order, filter }`. */
function unwrapHook<HandlerType extends AnyHookHandler>(
	hook: ObjectHook<HandlerType> | undefined,
): { handler: HandlerType; order: HookOrder; filter: HookFilter | undefined } | undefined {
	if (hook === undefined) {
		return undefined;
	}
	if (typeof hook === 'function') {
		return { handler: hook, order: undefined, filter: undefined };
	}
	return { handler: hook.handler, order: hook.order, filter: hook.filter };
}

export class PluginContainer {
	private readonly config: ResolvedConfig;
	private readonly plugins: readonly Plugin[];
	private readonly parse: AstParser;
	private readonly emittedFileSink?: EmittedFileSink;
	private readonly onWarn?: (warning: string) => void;
	private readonly onWatchFile?: (id: string, environment: ViteEnvironmentName) => void;

	private readonly moduleInfo = new Map<string, ModuleInfo>();
	private buildStarted = false;
	private defaultResolve?: DefaultResolve;

	constructor(options: PluginContainerOptions) {
		this.config = options.config;
		this.plugins = options.plugins;
		this.parse = options.parse;
		this.emittedFileSink = options.emittedFileSink;
		this.onWarn = options.onWarn;
		this.onWatchFile = options.onWatchFile;
	}

	/**
	 * Build the container for a flattened, ordered plugin set. Plugins are
	 * sorted by `enforce`/`order`: `pre` first, then normal, then `post`.
	 */
	static create(options: Omit<PluginContainerOptions, 'plugins'> & { plugins: PluginOption[] }): PluginContainer {
		const flattened = flattenPlugins(options.plugins);
		return new PluginContainer({ ...options, plugins: flattened });
	}

	/** Install the fallback resolver used by `this.resolve` (set per build). */
	setDefaultResolve(defaultResolve: DefaultResolve | undefined): void {
		this.defaultResolve = defaultResolve;
	}

	private buildEnvironment(name: ViteEnvironmentName): HostEnvironment {
		// Mirror Vite's `this.environment.config`: a config view where the
		// per-environment `build`/`resolve`/`optimizeDeps`/`dev` override the
		// global config, so environment-gated plugins (e.g. plugin-rsc) read the
		// correct fields.
		const environmentConfig = this.config.environments[name];
		const config: ResolvedConfig = {
			...this.config,
			build: { ...this.config.build, ...environmentConfig?.build },
			resolve: { ...this.config.resolve, ...environmentConfig?.resolve },
			optimizeDeps: { ...this.config.optimizeDeps, ...environmentConfig?.optimizeDeps },
			dev: { ...this.config.dev, ...environmentConfig?.dev },
		};
		return { name, mode: this.config.command === 'build' ? 'build' : 'dev', config };
	}

	/** Whether a plugin participates in the given environment. */
	private appliesToEnvironment(plugin: Plugin, environment: HostEnvironment): boolean {
		if (plugin.applyToEnvironment === undefined) {
			return true;
		}
		return plugin.applyToEnvironment(environment);
	}

	private orderedFor(environment: HostEnvironment): OrderedPlugins {
		const active = this.plugins.filter((plugin) => this.appliesToEnvironment(plugin, environment));
		return {
			resolveId: sortPluginsByHookOrder(active, 'resolveId'),
			load: sortPluginsByHookOrder(active, 'load'),
			transform: sortPluginsByHookOrder(active, 'transform'),
			buildStart: sortPluginsByHookOrder(active, 'buildStart'),
			transformIndexHtml: sortPluginsByHookOrder(active, 'transformIndexHtml'),
			hotUpdate: sortPluginsByHookOrder(active, 'hotUpdate'),
			renderChunk: sortPluginsByHookOrder(active, 'renderChunk'),
			generateBundle: sortPluginsByHookOrder(active, 'generateBundle'),
			writeBundle: sortPluginsByHookOrder(active, 'writeBundle'),
			buildEnd: sortPluginsByHookOrder(active, 'buildEnd'),
			closeBundle: sortPluginsByHookOrder(active, 'closeBundle'),
		};
	}

	private createContext(environment: HostEnvironment, pluginName: string, activeSkip?: ReadonlySet<string>): PluginContext {
		return {
			resolve: async (source, importer, options) => {
				const ssr = options.ssr ?? environment.name !== 'client';
				// Rollup (>=3) skips the calling plugin by default; only `skipSelf:
				// false` opts back in. The skip set accumulates every plugin already
				// active in this resolution chain so a re-resolving plugin can't
				// recurse back into another re-resolving plugin (and vice-versa)
				// without end — matching Rollup's `skip` array semantics.
				const skipSelf = options.skipSelf !== false;
				const skip = skipSelf ? new Set([...(activeSkip ?? []), pluginName]) : activeSkip;
				const pluginResult = await this.resolveId(source, importer, {
					ssr,
					environment: environment.name,
					importer,
					skip,
				});
				if (pluginResult !== undefined) {
					return pluginResult;
				}
				// No plugin resolved it: fall back to default resolution so callers
				// (e.g. plugin-rsc resolving client references) get a concrete result.
				const fallback = this.defaultResolve?.(source, importer, environment.name);
				return fallback === undefined ? undefined : { id: fallback.id, external: fallback.external, meta: {} };
			},
			emitFile: (file) => {
				if (this.emittedFileSink === undefined) {
					throw new PluginHookError('emitFile is not supported in this context', pluginName, 'emitFile');
				}
				return this.emittedFileSink.emit(file, environment.name);
			},
			getFileName: (referenceId) => {
				if (this.emittedFileSink === undefined) {
					throw new PluginHookError('getFileName is not supported in this context', pluginName, 'getFileName');
				}
				return this.emittedFileSink.getFileName(referenceId);
			},
			getModuleInfo: (id) => this.moduleInfo.get(id),
			addWatchFile: (id) => {
				this.onWatchFile?.(id, environment.name);
			},
			parse: (code, options) => this.parse(code, options),
			error: (error) => {
				const message = typeof error === 'string' ? error : error.message;
				throw new PluginHookError(message, pluginName, 'error');
			},
			warn: (warning) => {
				const message = typeof warning === 'string' ? warning : warning.message;
				this.onWarn?.(`[${pluginName}] ${message}`);
			},
			environment,
			meta: { framework: 'vite-host' },
		};
	}

	/** Run all `buildStart` hooks once per container lifetime. */
	async buildStart(environmentName: ViteEnvironmentName = 'client'): Promise<void> {
		if (this.buildStarted) {
			return;
		}
		this.buildStarted = true;
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).buildStart) {
			const hook = unwrapHook(plugin.buildStart);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			await Reflect.apply(hook.handler, context, []);
		}
	}

	/**
	 * Resolve an import specifier. The first plugin to return a non-null result
	 * wins (Rollup "first hook wins" semantics). Unresolved specifiers return
	 * `undefined` so callers can fall back to default resolution.
	 */
	async resolveId(source: string, importer: string | undefined, options: ResolveIdOptions): Promise<ResolveResult | undefined> {
		const environment = this.buildEnvironment(options.environment);
		for (const plugin of this.orderedFor(environment).resolveId) {
			const hook = unwrapHook(plugin.resolveId);
			if (hook === undefined || !matchesHookFilter(hook.filter, source)) {
				continue;
			}
			if (options.skip?.has(plugin.name)) {
				continue;
			}
			const context = this.createContext(environment, plugin.name, options.skip);
			const result = await Reflect.apply(hook.handler, context, [source, importer, options]);
			if (result === undefined || result === null || result === false) {
				continue;
			}
			if (typeof result === 'string') {
				return { id: result, external: false, meta: {} };
			}
			this.recordModuleMeta(result);
			return { id: result.id, external: result.external ?? false, meta: result.meta ?? {} };
		}
		return undefined;
	}

	/** Load a module's source. First plugin to return content wins. */
	async load(id: string, environmentName: ViteEnvironmentName): Promise<LoadOutput | undefined> {
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).load) {
			const hook = unwrapHook(plugin.load);
			if (hook === undefined || !matchesHookFilter(hook.filter, id)) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			const result = await Reflect.apply(hook.handler, context, [id]);
			if (result === undefined || result === null) {
				continue;
			}
			if (typeof result === 'string') {
				return { code: result, meta: {} };
			}
			this.recordModuleMeta({ id, meta: result.meta });
			return { code: result.code, map: result.map, meta: result.meta ?? {} };
		}
		return undefined;
	}

	/**
	 * Run the `transform` chain. Unlike resolve/load, every applicable plugin
	 * runs in order and feeds its output to the next (Rollup pipe semantics).
	 */
	async transform(code: string, id: string, environmentName: ViteEnvironmentName): Promise<TransformOutput> {
		const environment = this.buildEnvironment(environmentName);
		let currentCode = code;
		let currentMap: ModuleTransformResult['map'];
		const meta: Record<string, unknown> = {};
		for (const plugin of this.orderedFor(environment).transform) {
			const hook = unwrapHook(plugin.transform);
			if (hook === undefined || !matchesHookFilter(hook.filter, id, currentCode)) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			const result = await Reflect.apply(hook.handler, context, [currentCode, id]);
			if (result === undefined || result === null) {
				continue;
			}
			if (typeof result === 'string') {
				currentCode = result;
				continue;
			}
			currentCode = result.code;
			if (result.map !== undefined) {
				currentMap = result.map;
			}
			if (result.meta !== undefined) {
				Object.assign(meta, result.meta);
			}
		}
		return { code: currentCode, map: currentMap, meta };
	}

	/** Apply every plugin's `transformIndexHtml` hook in order. */
	async transformIndexHtml(html: string, context: IndexHtmlTransformContext): Promise<string> {
		const environment = this.buildEnvironment('client');
		let current = html;
		const pendingTags: import('./types').HtmlTagDescriptor[] = [];
		for (const plugin of this.orderedFor(environment).transformIndexHtml) {
			const hook = plugin.transformIndexHtml;
			if (hook === undefined) {
				continue;
			}
			const handler = typeof hook === 'function' ? hook : hook.handler;
			const result = await handler(current, context);
			if (result === undefined) {
				continue;
			}
			if (typeof result === 'string') {
				current = result;
				continue;
			}
			if (Array.isArray(result)) {
				pendingTags.push(...result);
				continue;
			}
			current = result.html;
			pendingTags.push(...result.tags);
		}
		return injectHtmlTags(current, pendingTags);
	}

	/** Run `hotUpdate` hooks, collecting the affected module set for HMR. */
	async hotUpdate(context: HotUpdateContext): Promise<ModuleInfo[]> {
		const ordered = this.orderedFor(context.environment).hotUpdate;
		let modules = context.modules;
		for (const plugin of ordered) {
			const hook = unwrapHook(plugin.hotUpdate);
			if (hook === undefined) {
				continue;
			}
			const pluginContext = this.createContext(context.environment, plugin.name);
			const result = await Reflect.apply(hook.handler, pluginContext, [{ ...context, modules }]);
			if (Array.isArray(result)) {
				modules = result;
			}
		}
		return modules;
	}

	/** Run the `renderChunk` chain for one chunk, piping code through plugins. */
	async renderChunk(
		code: string,
		chunk: OutputChunk,
		options: NormalizedOutputOptions,
		environmentName: ViteEnvironmentName,
	): Promise<string> {
		const environment = this.buildEnvironment(environmentName);
		let current = code;
		for (const plugin of this.orderedFor(environment).renderChunk) {
			const hook = unwrapHook(plugin.renderChunk);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			const result = await Reflect.apply(hook.handler, context, [current, chunk, options]);
			if (result === undefined || result === null) {
				continue;
			}
			current = typeof result === 'string' ? result : result.code;
		}
		return current;
	}

	/** Run every `generateBundle` hook in order; plugins may mutate the bundle. */
	async generateBundle(
		options: NormalizedOutputOptions,
		bundle: OutputBundle,
		isWrite: boolean,
		environmentName: ViteEnvironmentName,
	): Promise<void> {
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).generateBundle) {
			const hook = unwrapHook(plugin.generateBundle);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			await Reflect.apply(hook.handler, context, [options, bundle, isWrite]);
		}
	}

	/** Run every `writeBundle` hook in order (after outputs are written). */
	async writeBundle(options: NormalizedOutputOptions, bundle: OutputBundle, environmentName: ViteEnvironmentName): Promise<void> {
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).writeBundle) {
			const hook = unwrapHook(plugin.writeBundle);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			await Reflect.apply(hook.handler, context, [options, bundle]);
		}
	}

	/** Run every `buildEnd` hook (optionally with a build error). */
	async buildEnd(environmentName: ViteEnvironmentName, error?: Error): Promise<void> {
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).buildEnd) {
			const hook = unwrapHook(plugin.buildEnd);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			await Reflect.apply(hook.handler, context, [error]);
		}
	}

	/** Run every `closeBundle` hook. */
	async closeBundle(environmentName: ViteEnvironmentName): Promise<void> {
		const environment = this.buildEnvironment(environmentName);
		for (const plugin of this.orderedFor(environment).closeBundle) {
			const hook = unwrapHook(plugin.closeBundle);
			if (hook === undefined) {
				continue;
			}
			const context = this.createContext(environment, plugin.name);
			await Reflect.apply(hook.handler, context, []);
		}
	}

	/** Find the first plugin that defines a `buildApp` hook, if any. */
	findBuildAppHook(): ((builder: import('./types').ViteBuilder) => void | Promise<void>) | undefined {
		for (const plugin of this.plugins) {
			const hook = unwrapHook(plugin.buildApp);
			if (hook !== undefined) {
				return hook.handler;
			}
		}
		return undefined;
	}

	private recordModuleMeta(partial: { id: string; meta?: Record<string, unknown> }): void {
		if (partial.meta === undefined) {
			return;
		}
		const existing = this.moduleInfo.get(partial.id);
		this.moduleInfo.set(partial.id, {
			id: partial.id,
			meta: { ...existing?.meta, ...partial.meta },
		});
	}
}

/** Inject `<head>`/`<body>` tag descriptors into an HTML document. */
function injectHtmlTags(html: string, tags: import('./types').HtmlTagDescriptor[]): string {
	if (tags.length === 0) {
		return html;
	}
	let result = html;
	const headPrepend: string[] = [];
	const headAppend: string[] = [];
	const bodyPrepend: string[] = [];
	const bodyAppend: string[] = [];
	for (const tag of tags) {
		const serialized = serializeTag(tag);
		switch (tag.injectTo) {
			case 'head-prepend': {
				headPrepend.push(serialized);
				break;
			}
			case 'body-prepend': {
				bodyPrepend.push(serialized);
				break;
			}
			case 'body': {
				bodyAppend.push(serialized);
				break;
			}
			default: {
				headAppend.push(serialized);
			}
		}
	}
	result = injectAt(result, '<head>', headPrepend.join(''), 'after');
	result = injectAt(result, '</head>', headAppend.join(''), 'before');
	result = injectAt(result, '<body>', bodyPrepend.join(''), 'after');
	result = injectAt(result, '</body>', bodyAppend.join(''), 'before');
	return result;
}

function injectAt(html: string, marker: string, content: string, position: 'before' | 'after'): string {
	if (content.length === 0) {
		return html;
	}
	const index = html.indexOf(marker);
	if (index === -1) {
		return position === 'before' ? html + content : content + html;
	}
	const insertAt = position === 'before' ? index : index + marker.length;
	return html.slice(0, insertAt) + content + html.slice(insertAt);
}

function serializeTag(tag: import('./types').HtmlTagDescriptor): string {
	const attributes = tag.attrs ?? {};
	const attributeString = Object.entries(attributes)
		.map(([key, value]) => {
			if (value === true) {
				return ` ${key}`;
			}
			if (value === false || value === undefined) {
				return '';
			}
			return ` ${key}="${String(value)}"`;
		})
		.join('');
	const children = typeof tag.children === 'string' ? tag.children : (tag.children ?? []).map((child) => serializeTag(child)).join('');
	const voidElements = new Set(['link', 'meta', 'base']);
	if (voidElements.has(tag.tag)) {
		return `<${tag.tag}${attributeString}>`;
	}
	return `<${tag.tag}${attributeString}>${children}</${tag.tag}>`;
}
