/**
 * Type surface for the in-worker Vite Surface Host.
 *
 * This is a faithful subset of the Rollup/Vite plugin API — enough to run the
 * native plugins our projects depend on (`@vitejs/plugin-react`,
 * `@vitejs/plugin-rsc`, `vinext`, and the Cloudflare integration) inside
 * workerd, backed by `esbuild-wasm`.
 *
 * We intentionally model the *public* contract these plugins rely on rather
 * than re-deriving Vite's internals. Where the real plugin API permits `null`
 * return values (e.g. "I don't handle this id"), we mirror that here for wire
 * compatibility; the host normalises those to `undefined` internally.
 */

/**
 * Vite build environments. Server components render in `rsc`, are streamed
 * through `ssr` for HTML, and hydrate in the browser via `client`.
 */
export type ViteEnvironmentName = 'client' | 'ssr' | 'rsc';

/** Whether the host is running a dev server or a production build. */
export type ViteCommand = 'serve' | 'build';

export interface ConfigEnvironment {
	command: ViteCommand;
	mode: string;
}

/** Vite `resolve.alias`: either a `find -> replacement` map or entry array. */
export type AliasConfig = Record<string, string> | Array<{ find: string | RegExp; replacement: string }>;

export interface ViteLogger {
	info(message: string): void;
	warn(message: string): void;
	warnOnce(message: string): void;
	error(message: string): void;
	hasWarned: boolean;
}

/**
 * Resolved config exposed to plugins via `configResolved`. Mirrors the subset of
 * Vite's `ResolvedConfig` that the native plugins (vinext, plugin-rsc,
 * plugin-react) read. Build-tool-specific options (rollup/rolldown) are accepted
 * but not acted on — the host drives esbuild directly.
 */
export interface ResolvedConfig {
	command: ViteCommand;
	mode: string;
	root: string;
	base: string;
	isProduction: boolean;
	publicDir: string;
	cacheDir: string;
	env: Record<string, string>;
	define: Record<string, unknown>;
	server: { hmr: boolean | Record<string, unknown>; middlewareMode: boolean };
	build: { sourcemap: boolean; assetsDir: string; target: string; outDir: string; rollupOptions: Record<string, unknown> };
	dev: { moduleRunnerTransform: boolean };
	resolve: { alias: AliasConfig; extensions: string[]; conditions: string[]; dedupe: string[] };
	optimizeDeps: { include: string[]; exclude: string[]; esbuildOptions: Record<string, unknown> };
	ssr: { external: string[]; noExternal: string[] | boolean; target: string };
	worker: { format: string; plugins: () => Plugin[] };
	css: Record<string, unknown>;
	esbuild: Record<string, unknown> | false;
	experimental: Record<string, unknown>;
	environments: Record<string, EnvironmentConfig>;
	logger: ViteLogger;
	assetsInclude: (file: string) => boolean;
	/** Vite's standalone resolver factory; returns a lazy id resolver. */
	createResolver: () => (id: string, importer?: string) => Promise<string | undefined>;
	plugins: readonly Plugin[];
}

/** User config object passed through the `config` hook merge chain. */
export interface UserConfig {
	root?: string;
	base?: string;
	mode?: string;
	plugins?: PluginOption[];
	resolve?: { alias?: AliasConfig; extensions?: string[] };
	environments?: Record<string, EnvironmentConfig>;
	[key: string]: unknown;
}

export interface EnvironmentConfig {
	consumer?: 'client' | 'server';
	build?: {
		outDir?: string;
		assetsDir?: string;
		sourcemap?: boolean;
		target?: string;
		emptyOutDir?: boolean;
		rollupOptions?: Record<string, unknown>;
		lib?: false | Record<string, unknown>;
	};
	resolve?: {
		external?: string[];
		noExternal?: string[] | boolean;
		conditions?: string[];
		dedupe?: string[];
		alias?: AliasConfig;
	};
	optimizeDeps?: { include?: string[]; exclude?: string[]; esbuildOptions?: Record<string, unknown> };
	dev?: Record<string, unknown>;
	keepProcessEnv?: boolean;
	[key: string]: unknown;
}

/** Hook execution order, matching Rollup/Vite `enforce`/`order` semantics. */
export type HookOrder = 'pre' | 'post' | undefined;

/**
 * Object-form hook. Plugins may supply either a bare handler function or an
 * object with `{ handler, order, filter }` (Vite 8 / Rolldown hook filters).
 * The container normalises both.
 */
export type ObjectHook<HandlerType> =
	| HandlerType
	| { handler: HandlerType; order?: HookOrder; filter?: import('./hook-filter').HookFilter };

export interface PartialResolvedId {
	id: string;
	external?: boolean;
	meta?: Record<string, unknown>;
}

// Plugin hooks may legitimately return null to signal "not handled"; the union
// mirrors the real API. The container never *produces* null itself.

export type ResolveIdResult = string | PartialResolvedId | undefined | null | false;

export interface SourceMapInput {
	mappings: string;
	[key: string]: unknown;
}

export interface ModuleTransformResult {
	code: string;
	map?: string | SourceMapInput;
	meta?: Record<string, unknown>;
}

export type LoadResult = string | ModuleTransformResult | undefined | null;

export type TransformHookResult = string | ModuleTransformResult | undefined | null;

export interface ResolveIdOptions {
	/** True when resolving for a server environment (`ssr` or `rsc`). */
	ssr: boolean;
	environment: ViteEnvironmentName;
	importer?: string;
	/**
	 * Names of plugins to skip during this resolution. Accumulated across nested
	 * `this.resolve(..., { skipSelf: true })` calls: each plugin that re-enters
	 * resolution from its own `resolveId` hook is added to the set so the chain
	 * cannot recurse back into an already-active plugin. Without this, two
	 * plugins that both re-resolve the same specifier (e.g. vinext + plugin-rsc
	 * deduping a declared `react` dependency) recurse into each other unboundedly
	 * (Rollup's `skip` semantics).
	 */
	skip?: ReadonlySet<string>;
}

export interface EmittedAsset {
	type: 'asset';
	name?: string;
	fileName?: string;
	source: string | Uint8Array;
}

export interface EmittedChunk {
	type: 'chunk';
	id: string;
	name?: string;
	fileName?: string;
}

export type EmittedFile = EmittedAsset | EmittedChunk;

export interface ModuleInfo {
	id: string;
	meta: Record<string, unknown>;
}

/**
 * The `this` context handed to plugin hooks. A trimmed Rollup `PluginContext`
 * plus the Vite environment accessor that `@vitejs/plugin-rsc` branches on.
 */
export interface PluginContext {
	resolve(
		source: string,
		importer: string | undefined,
		options: { ssr?: boolean; skipSelf?: boolean },
	): Promise<PartialResolvedId | undefined>;
	emitFile(file: EmittedFile): string;
	getFileName(referenceId: string): string;
	getModuleInfo(id: string): ModuleInfo | undefined;
	addWatchFile(id: string): void;
	parse(code: string, options?: unknown): unknown;
	error(error: string | Error): never;
	warn(warning: string | { message: string }): void;
	/** The environment this hook is currently executing for. */
	readonly environment: HostEnvironment;
	readonly meta: { readonly framework: 'vite-host' };
}

/**
 * Per-environment handle exposed to plugins. Mirrors `this.environment` from
 * Vite's Environment API closely enough for plugin branching and HMR.
 */
export interface HostEnvironment {
	readonly name: ViteEnvironmentName;
	readonly mode: 'dev' | 'build';
	readonly config: ResolvedConfig;
}

/** A rendered output chunk, mirroring Rollup's `OutputChunk`. */
export interface OutputChunk {
	type: 'chunk';
	fileName: string;
	code: string;
	name: string;
	isEntry: boolean;
	isDynamicEntry: boolean;
	facadeModuleId: string | undefined;
	modules: Record<string, { renderedExports: string[]; removedExports: string[] }>;
	moduleIds: string[];
	imports: string[];
	dynamicImports: string[];
	exports: string[];
	map?: SourceMapInput;
	/**
	 * Vite's per-chunk asset metadata. `@vitejs/plugin-rsc` reads
	 * `importedCss` to collect the route's stylesheets into the RSC assets
	 * manifest (which drives `<link rel="stylesheet">` injection).
	 */
	viteMetadata: { importedCss: Set<string>; importedAssets: Set<string> };
}

/** A rendered output asset, mirroring Rollup's `OutputAsset`. */
export interface OutputAsset {
	type: 'asset';
	fileName: string;
	name: string | undefined;
	names: string[];
	source: string | Uint8Array;
}

export type OutputBundle = Record<string, OutputChunk | OutputAsset>;

export interface NormalizedOutputOptions {
	format: string;
	dir?: string;
	entryFileNames: string;
	chunkFileNames: string;
	assetFileNames: string;
}

export interface RenderChunkResult {
	code: string;
	map?: SourceMapInput;
}

export interface HotUpdateContext {
	readonly type: 'create' | 'update' | 'delete';
	readonly file: string;
	readonly timestamp: number;
	readonly modules: ModuleInfo[];
	readonly environment: HostEnvironment;
	read(): Promise<string>;
}

export interface IndexHtmlTransformContext {
	path: string;
	filename: string;
}

export interface HtmlTagDescriptor {
	tag: string;
	attrs?: Record<string, string | boolean | undefined>;
	children?: string | HtmlTagDescriptor[];
	injectTo?: 'head' | 'body' | 'head-prepend' | 'body-prepend';
}

export interface IndexHtmlTransformResult {
	html: string;
	tags: HtmlTagDescriptor[];
}

export type TransformIndexHtmlHandler = (
	this: void,
	html: string,
	context: IndexHtmlTransformContext,
) =>
	| string
	| HtmlTagDescriptor[]
	| IndexHtmlTransformResult
	| undefined
	| void
	| Promise<string | HtmlTagDescriptor[] | IndexHtmlTransformResult | undefined | void>;

export type TransformIndexHtmlHook =
	| TransformIndexHtmlHandler
	| {
			order?: HookOrder;
			handler: TransformIndexHtmlHandler;
	  };

/**
 * The plugin contract. Every field is optional except `name`. Hooks accept the
 * object-form so we can honour the `order` modifier the real plugins use.
 */
export interface Plugin {
	name: string;
	enforce?: 'pre' | 'post';
	apply?: ViteCommand | ((config: UserConfig, environment: ConfigEnvironment) => boolean);

	config?: ObjectHook<
		(config: UserConfig, environment: ConfigEnvironment) => UserConfig | undefined | void | Promise<UserConfig | undefined | void>
	>;
	configResolved?: ObjectHook<(config: ResolvedConfig) => void | Promise<void>>;
	buildStart?: ObjectHook<(this: PluginContext) => void | Promise<void>>;

	resolveId?: ObjectHook<
		(
			this: PluginContext,
			source: string,
			importer: string | undefined,
			options: ResolveIdOptions,
		) => ResolveIdResult | Promise<ResolveIdResult>
	>;
	load?: ObjectHook<(this: PluginContext, id: string) => LoadResult | Promise<LoadResult>>;
	transform?: ObjectHook<(this: PluginContext, code: string, id: string) => TransformHookResult | Promise<TransformHookResult>>;

	transformIndexHtml?: TransformIndexHtmlHook;
	hotUpdate?: ObjectHook<(this: PluginContext, context: HotUpdateContext) => ModuleInfo[] | void | Promise<ModuleInfo[] | void>>;

	// --- Output (generate) phase hooks, mirroring Rollup ---
	renderChunk?: ObjectHook<
		(
			this: PluginContext,
			code: string,
			chunk: OutputChunk,
			options: NormalizedOutputOptions,
		) => string | RenderChunkResult | undefined | null | Promise<string | RenderChunkResult | undefined | null>
	>;
	generateBundle?: ObjectHook<
		(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle, isWrite: boolean) => void | Promise<void>
	>;
	writeBundle?: ObjectHook<(this: PluginContext, options: NormalizedOutputOptions, bundle: OutputBundle) => void | Promise<void>>;
	buildEnd?: ObjectHook<(this: PluginContext, error?: Error) => void | Promise<void>>;
	closeBundle?: ObjectHook<(this: PluginContext) => void | Promise<void>>;
	/** Vite multi-environment build orchestration entry point. */
	buildApp?: ObjectHook<(builder: ViteBuilder) => void | Promise<void>>;

	/** Vite Environment API gate: return false to skip this plugin for an env. */
	applyToEnvironment?: (environment: HostEnvironment) => boolean;
}

/**
 * One environment as seen by the build orchestrator. `config` is the resolved
 * per-environment config; plugins read `build.outDir`/`build.rollupOptions.input`
 * and toggle `build.write` across scan/build passes.
 */
export interface BuilderEnvironment {
	name: string;
	config: {
		build: {
			outDir: string;
			write?: boolean;
			rollupOptions: { input?: unknown };
			[key: string]: unknown;
		};
		[key: string]: unknown;
	};
}

/** Vite's build orchestrator, passed to `buildApp` hooks. */
export interface ViteBuilder {
	config: ResolvedConfig;
	environments: Record<string, BuilderEnvironment>;
	build(environment: BuilderEnvironment): Promise<void>;
}

/** A plugin option without the promise wrapper (the awaited form). */
export type AwaitablePluginOption = Plugin | false | undefined | PluginOption[];

/**
 * Plugins may be nested/conditional arrays, falsy, or promises (Vite awaits
 * promise entries — vinext returns its RSC plugin set as a promise). Resolved
 * to a flat `Plugin[]` before use. Matches Vite's `PluginOption`: the promise
 * wraps the non-promise variants, which keeps the type non-recursive through
 * `then`.
 */
export type PluginOption = AwaitablePluginOption | Promise<AwaitablePluginOption>;
