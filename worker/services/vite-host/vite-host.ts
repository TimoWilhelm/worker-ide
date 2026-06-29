/**
 * ViteHost — the orchestrator that runs the in-worker Vite surface.
 *
 * Given a snapshot of the project tree and a plugin factory, it:
 *  1. hydrates the in-memory project filesystem and publishes host services
 *     (esbuild-backed transform, env loading) that the `vite` shim delegates to;
 *  2. invokes the plugin factory (e.g. `vinext()` from the vendored bundle) —
 *     which reads the project tree, so it must run *after* the filesystem is
 *     installed;
 *  3. resolves the Vite config lifecycle into a {@link PluginContainer};
 *  4. exposes `bundle()` to produce a per-environment ES module set for the
 *     LOADER isolate.
 *
 * One ViteHost instance corresponds to one project build context and runs
 * entirely inside a single workerd isolate alongside esbuild-wasm.
 */
import { runBuildApp } from './build-app';
import { resolveConfig } from './config/resolve-config';
import { toEsbuildDefine } from './define';
import { EmittedFiles } from './emitted-files';
import { bundleEnvironment, bundleModuleGraph } from './esbuild-bridge';
import { ensureEsbuild } from './esbuild-runtime';
import { MemoryFileSystem } from './node-fs/memory-file-system';
import { installProjectFileSystem } from './node-fs/node-fs-bridge';
import { PluginContainer } from './plugin-container';
import { seedNodeModules } from './runtime/seed-node-modules';
import { parseAst } from './vite-shim/index';
import { installViteHostServices } from './vite-shim/services';

import type { BundleResult, EnvironmentBundle } from './esbuild-bridge';
import type { Esbuild } from './esbuild-runtime';
import type { BuilderEnvironment, PluginOption, ResolvedConfig, ViteCommand, ViteEnvironmentName } from './types';

export interface ViteHostOptions {
	/** Project tree snapshot (`/absolute/path` → contents). */
	files: Record<string, string>;
	root: string;
	command: ViteCommand;
	mode: string;
	env?: Record<string, string>;
	/**
	 * Produces the plugin option tree. Invoked after the filesystem + services
	 * are installed so plugin factories (vinext) can read the project tree.
	 */
	createPlugins: () => PluginOption[] | Promise<PluginOption[]>;
	/**
	 * Seed framework-specific runtime modules into the in-memory filesystem before
	 * plugins run (e.g. vinext's `dist` runtime). React/RSC packages are always
	 * seeded; this is for anything a particular framework adapter needs on top.
	 */
	seedRuntime?: (fileSystem: MemoryFileSystem) => void;
}

export interface BundleRequest {
	entryId: string;
	environment: ViteEnvironmentName;
	externals?: string[];
	sourcemap?: boolean;
}

function transformLoader(id: string): 'ts' | 'tsx' | 'jsx' | 'js' {
	const file = id.split('?')[0];
	if (file.endsWith('.tsx')) return 'tsx';
	if (file.endsWith('.ts') || file.endsWith('.mts')) return 'ts';
	if (file.endsWith('.jsx')) return 'jsx';
	return 'js';
}

export class ViteHost {
	private constructor(
		private readonly container: PluginContainer,
		private readonly fileSystem: MemoryFileSystem,
		private readonly esbuild: Esbuild,
		private readonly emittedFiles: EmittedFiles,
		readonly config: ResolvedConfig,
	) {}

	static async create(options: ViteHostOptions): Promise<ViteHost> {
		const esbuild = await ensureEsbuild();
		const fileSystem = MemoryFileSystem.fromSnapshot(options.files);
		// The React/RSC package source is always resolvable; framework adapters
		// seed any additional runtime modules they need (e.g. vinext's `dist`).
		seedNodeModules(fileSystem);
		options.seedRuntime?.(fileSystem);

		// vinext resolves the project root from the working directory at factory
		// time; the host defines it as the project root so app/pages detection
		// targets the in-memory tree.
		if (typeof process !== 'undefined' && typeof process.cwd === 'function') {
			process.cwd = () => options.root;
		}

		installProjectFileSystem(fileSystem);
		installViteHostServices({
			transform: async (code, id, transformOptions) => {
				const result = await esbuild.transform(code, {
					loader: transformLoader(id),
					sourcefile: id,
					format: 'esm',
					target: 'es2022',
					jsx: 'automatic',
					sourcemap: transformOptions?.sourcemap ? 'inline' : false,
				});
				return { code: result.code, map: result.map || undefined };
			},
			loadEnv: () => options.env ?? {},
		});

		const pluginOptions = await options.createPlugins();
		const { config, plugins } = await resolveConfig({
			plugins: pluginOptions,
			command: options.command,
			mode: options.mode,
			root: options.root,
			env: options.env,
		});

		const emittedFiles = new EmittedFiles();
		const container = new PluginContainer({
			config,
			plugins,
			parse: (code) => parseAst(code),
			emittedFileSink: emittedFiles,
		});

		return new ViteHost(container, fileSystem, esbuild, emittedFiles, config);
	}

	/** Names of the resolved plugins, in execution order. */
	get pluginNames(): string[] {
		return this.config.plugins.map((plugin) => plugin.name);
	}

	/** Read a file from the project filesystem (e.g. plugin-emitted output). */
	readFile(path: string): string {
		return this.fileSystem.readFileText(path);
	}

	/** Bundle one environment's module graph into a single ESM string. */
	async bundle(request: BundleRequest): Promise<BundleResult> {
		return bundleModuleGraph({
			esbuild: this.esbuild,
			container: this.container,
			fileSystem: this.fileSystem,
			entryId: request.entryId,
			environment: request.environment,
			externals: request.externals ?? [],
			alias: this.config.resolve.alias,
			define: toEsbuildDefine(this.config),
			sourcemap: request.sourcemap,
		});
	}

	/** Bundle a server environment entry into a (code-split) output set. */
	async bundleServerEnvironment(request: BundleRequest): Promise<EnvironmentBundle> {
		return bundleEnvironment({
			esbuild: this.esbuild,
			container: this.container,
			fileSystem: this.fileSystem,
			entryId: request.entryId,
			environment: request.environment,
			externals: request.externals ?? [],
			alias: this.config.resolve.alias,
			define: toEsbuildDefine(this.config),
			sourcemap: request.sourcemap,
		});
	}

	/**
	 * Run the full multi-environment application build (the `buildApp`
	 * orchestration). Outputs are written into the in-memory filesystem under
	 * each environment's `outDir`.
	 */
	async build(externals: string[], serverEntryId?: string): Promise<Record<string, BuilderEnvironment>> {
		return runBuildApp({
			esbuild: this.esbuild,
			container: this.container,
			fileSystem: this.fileSystem,
			config: this.config,
			externals,
			serverEntryId,
			emittedFiles: this.emittedFiles,
		});
	}

	/** Read a file from the project filesystem, or `undefined` if absent. */
	tryReadFile(path: string): string | undefined {
		return this.fileSystem.exists(path) ? this.fileSystem.readFileText(path) : undefined;
	}

	/** esbuild + in-memory filesystem for the dev module server (HMR). */
	devModuleContext(): { esbuild: Esbuild; fileSystem: MemoryFileSystem } {
		return { esbuild: this.esbuild, fileSystem: this.fileSystem };
	}

	/**
	 * Drop the build output tree from the in-memory filesystem once it has been
	 * read out. The dev module server (HMR) only ever reads project source and
	 * vendored `node_modules`, never `/dist`, so a retained build's filesystem
	 * need not also hold the outputs that already live in the returned module
	 * maps — keeping a warm preview build cheap.
	 */
	dropBuildOutputs(directory = '/dist'): void {
		this.fileSystem.remove(directory, { recursive: true });
	}

	/**
	 * Read all files written under `directory`, keyed by path relative to it
	 * (e.g. the server build output under `/dist/server`).
	 */
	readOutput(directory: string): Record<string, string> {
		// Build outputs are written into the overlay, so reading them never needs
		// to decode the (read-through) vendored base layers.
		return this.fileSystem.readFilesUnder(directory);
	}
}
