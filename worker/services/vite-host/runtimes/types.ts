/**
 * Framework runtime abstraction for the in-worker Vite Surface Host.
 *
 * A {@link FrameworkRuntime} encapsulates everything framework-specific about a
 * project type — detection, build, preview serving, HMR, and deploy packaging —
 * behind one interface. vinext and plain React are implemented as adapters;
 * adding Svelte or TanStack Start later means implementing this interface and
 * registering it (see `registry.ts`). The build Durable Object, preview router,
 * and deploy workflow stay generic and delegate to the selected runtime.
 */
import type { MemoryFileSystem } from '../node-fs/memory-file-system';
import type { ServerFetcher } from '../runtime/app-runtime';
import type { DevelopmentModuleContext } from '../runtime/development-module-server';
import type { PluginOption } from '../types';
import type { ResolvedAssetSettings } from '@shared/types';

/** A cheap project snapshot for detection: `path -> contents` (leading slash optional). */
export interface ProjectProbe {
	files: Record<string, string>;
}

/** The output of building a project, shared by preview and deploy. */
export interface RuntimeBuild {
	/** Entry module name within {@link serverModules} (the server isolate's main). */
	mainModule: string;
	/** Server module set run in a `LOADER` isolate (SSR/RSC, or the API worker). */
	serverModules: Record<string, string>;
	/** Client build output, served as static assets. */
	clientOutput: Record<string, string>;
}

/** A build plus the esbuild/filesystem context the dev module server reuses for HMR. */
export interface RuntimePreviewBuild extends RuntimeBuild {
	devContext: DevelopmentModuleContext;
}

/** Context handed to a runtime when routing a preview request. */
export interface RuntimeRouteContext {
	clientOutput: Record<string, string>;
	/** Lazily instantiate (or reuse) the server isolate for this build. */
	getServer: () => ServerFetcher;
	projectRoot: string;
}

/** Context handed to a stateless runtime to serve a preview request. */
export interface StatelessPreviewContext {
	projectRoot: string;
	projectId: string;
	ideOrigin: string;
	assetSettings: ResolvedAssetSettings;
}

interface BaseRuntime {
	/** Stable identifier (also used in cache keys + logs). */
	readonly id: string;
	/** Whether this runtime claims the given project. */
	detect(probe: ProjectProbe): boolean;
}

/**
 * A runtime whose build is expensive and stateful, hosted in the per-project
 * build Durable Object (vinext, plain React on Vite, …). It produces a warm
 * build and routes preview requests across it, with module-level HMR.
 */
export interface DurableFrameworkRuntime extends BaseRuntime {
	readonly hosting: 'durable';
	/** Compatibility flags the built server isolate requires. */
	readonly serverCompatibilityFlags: readonly string[];
	/** Framework Vite plugins (e.g. `vinext()`); empty for plugin-less builds. */
	createPlugins(): PluginOption[] | Promise<PluginOption[]>;
	/** Seed framework runtime modules into the in-memory fs (optional). */
	seedRuntime?(fileSystem: MemoryFileSystem): void;
	/**
	 * Build the project from a snapshot. `hostDevelopment` selects the preview
	 * build (unbundled, HMR-able client references) over the production deploy
	 * build (fully bundled, standalone).
	 */
	build(snapshot: Record<string, string>, options: { hostDevelopment: boolean }): Promise<RuntimePreviewBuild>;
	/** Route a preview request across the build (static asset / SSR / SPA fallback). */
	route(request: Request, context: RuntimeRouteContext): Promise<Response>;
	/**
	 * Browser HMR glue injected (as a classic script) into preview HTML. It bridges
	 * the coordinator's `vinext:hmr` events to the framework's surgical update path.
	 */
	hmrGlue(): string;
}

/**
 * A runtime whose preview is cheap and per-request (no warm build), served
 * inline in the stateless worker — e.g. a static React SPA + worker. It owns its
 * own request routing.
 */
export interface StatelessFrameworkRuntime extends BaseRuntime {
	readonly hosting: 'stateless';
	serve(request: Request, context: StatelessPreviewContext): Promise<Response>;
}

export type FrameworkRuntime = DurableFrameworkRuntime | StatelessFrameworkRuntime;
