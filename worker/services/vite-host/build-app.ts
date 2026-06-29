/**
 * Multi-environment build orchestration — the `builder.buildApp` surface.
 *
 * `@vitejs/plugin-rsc` drives the App Router build through Vite's builder: it
 * registers a `buildApp` hook that runs the environments in sequence
 * (rsc scan → ssr scan → rsc → client → ssr), toggling `build.write` and sharing
 * a client-reference manifest across passes via its internal manager. This
 * module provides a faithful {@link ViteBuilder} on top of the esbuild bridge:
 * each `builder.build(env)` bundles the environment's entry, constructs a
 * Rollup-compatible output bundle, runs the `renderChunk`/`generateBundle`/
 * `writeBundle` hooks, and writes outputs to the in-memory filesystem when the
 * pass is not a scan.
 */
import { toEsbuildDefine } from './define';
import { bundleEnvironment } from './esbuild-bridge';

import type { EmittedFiles } from './emitted-files';
import type { Esbuild } from './esbuild-runtime';
import type { MemoryFileSystem } from './node-fs/memory-file-system';
import type { PluginContainer } from './plugin-container';
import type {
	BuilderEnvironment,
	NormalizedOutputOptions,
	OutputBundle,
	OutputChunk,
	ResolvedConfig,
	ViteBuilder,
	ViteEnvironmentName,
} from './types';

export interface RunBuildAppOptions {
	esbuild: Esbuild;
	container: PluginContainer;
	fileSystem: MemoryFileSystem;
	config: ResolvedConfig;
	/** Bare specifiers left external (provided by the runtime isolate). */
	externals: string[];
	/**
	 * Overrides the rsc environment's entry with the worker entry (e.g.
	 * `vinext/server/app-router-entry`) so the built rsc output is a worker with a
	 * `default.fetch`, and plugin-rsc's `renderChunk` rewrites `loadModule('ssr')`
	 * to a relative import of the ssr bundle.
	 */
	serverEntryId?: string;
	/** Collector for `this.emitFile` outputs, drained into each environment's outDir. */
	emittedFiles: EmittedFiles;
}

const ENVIRONMENT_NAMES: ViteEnvironmentName[] = ['client', 'ssr', 'rsc'];

function entryForEnvironment(environment: BuilderEnvironment): { id: string; name: string } | undefined {
	const input = environment.config.build.rollupOptions.input;
	if (typeof input === 'string') {
		return { id: input, name: 'index' };
	}
	if (input !== null && typeof input === 'object') {
		const entries = Object.entries(input);
		const first = entries[0];
		return first !== undefined && typeof first[1] === 'string' ? { id: first[1], name: first[0] } : undefined;
	}
	return undefined;
}

function outputOptionsFor(environment: BuilderEnvironment): NormalizedOutputOptions {
	return {
		format: 'es',
		dir: environment.config.build.outDir,
		entryFileNames: '[name].js',
		chunkFileNames: 'chunks/[name]-[hash].js',
		assetFileNames: 'assets/[name]-[hash][extname]',
	};
}

/**
 * Build one environment: bundle its entry, run the output-hook pipeline, and
 * (unless this is a scan pass with `build.write === false`) write the resulting
 * files into the project filesystem under the environment's `outDir`.
 */
async function buildOneEnvironment(
	environment: BuilderEnvironment,
	environmentName: ViteEnvironmentName,
	options: RunBuildAppOptions,
): Promise<void> {
	const configuredEntry = entryForEnvironment(environment);
	// The rsc environment is the worker: build the worker entry when provided so
	// its output has a `default.fetch` and the ssr loadModule rewrite applies.
	const entry =
		environmentName === 'rsc' && options.serverEntryId !== undefined ? { id: options.serverEntryId, name: 'index' } : configuredEntry;
	if (entry === undefined) {
		// No input configured for this environment (e.g. fallback) — nothing to do.
		return;
	}
	const entryId = entry.id;

	const bundle = await bundleEnvironment({
		esbuild: options.esbuild,
		container: options.container,
		fileSystem: options.fileSystem,
		entryId,
		entryName: entry.name,
		environment: environmentName,
		externals: options.externals,
		alias: options.config.resolve.alias,
		// Activate vinext's client RSC-HMR only for the browser build in host dev.
		define: toEsbuildDefine(options.config, { clientHmr: environmentName === 'client' && globalThis.__VINEXT_HOST_DEV__ === true }),
	});

	const outputOptions = outputOptionsFor(environment);
	const outputBundle: OutputBundle = {};
	for (const file of bundle.files) {
		if (file.isCss) {
			// CSS is an emitted asset, not a JS chunk. plugin-rsc asserts CSS in the
			// bundle is `type: 'asset'` when copying it to the client output.
			outputBundle[file.fileName] = {
				type: 'asset',
				fileName: file.fileName,
				name: file.fileName,
				names: [file.fileName],
				source: file.text,
			};
			continue;
		}
		const chunk: OutputChunk = {
			type: 'chunk',
			fileName: file.fileName,
			code: file.text,
			name: file.fileName.replace(/\.js$/, ''),
			isEntry: file.isEntry,
			isDynamicEntry: false,
			facadeModuleId: file.isEntry ? entryId : undefined,
			modules: Object.fromEntries(
				file.moduleIds.map((id) => [id, { renderedExports: bundle.moduleExports[id] ?? [], removedExports: [] }]),
			),
			moduleIds: file.moduleIds,
			imports: file.imports,
			dynamicImports: [],
			exports: [],
			// plugin-rsc collects the route's stylesheets from each chunk's
			// `importedCss` into the RSC assets manifest.
			viteMetadata: { importedCss: new Set(file.importedCss), importedAssets: new Set() },
		};
		outputBundle[file.fileName] = chunk;
	}

	// renderChunk: pipe each chunk's code through the plugins.
	for (const fileName of Object.keys(outputBundle)) {
		const entry = outputBundle[fileName];
		if (entry.type !== 'chunk') {
			continue;
		}
		entry.code = await options.container.renderChunk(entry.code, entry, outputOptions, environmentName);
	}

	await options.container.buildEnd(environmentName);
	const isWrite = environment.config.build.write !== false;
	await options.container.generateBundle(outputOptions, outputBundle, isWrite, environmentName);

	// Fold assets emitted via `this.emitFile` during generateBundle into the bundle.
	for (const asset of options.emittedFiles.assetsFor(environmentName)) {
		outputBundle[asset.fileName] = {
			type: 'asset',
			fileName: asset.fileName,
			name: undefined,
			names: [],
			source: asset.source,
		};
	}

	if (isWrite) {
		const outputDirectory = environment.config.build.outDir.replace(/\/$/, '');
		for (const [fileName, entry] of Object.entries(outputBundle)) {
			const target = `${outputDirectory}/${fileName}`;
			const contents = entry.type === 'chunk' ? entry.code : entry.source;
			options.fileSystem.writeFile(target, contents);
		}
		await options.container.writeBundle(outputOptions, outputBundle, environmentName);
		await options.container.closeBundle(environmentName);
	}
}

/** Build the per-environment `BuilderEnvironment` views from resolved config. */
function createBuilderEnvironments(config: ResolvedConfig): Record<string, BuilderEnvironment> {
	const environments: Record<string, BuilderEnvironment> = {};
	for (const name of Object.keys(config.environments)) {
		const environmentConfig = config.environments[name];
		environments[name] = {
			name,
			config: {
				...environmentConfig,
				build: {
					outDir: environmentConfig.build?.outDir ?? `dist/${name}`,
					write: true,
					rollupOptions: environmentConfig.build?.rollupOptions ?? {},
					...environmentConfig.build,
				},
			},
		};
	}
	return environments;
}

/**
 * Run the application build. If a plugin provides a `buildApp` hook (plugin-rsc
 * does), delegate the multi-environment orchestration to it; otherwise build the
 * known environments directly.
 */
export async function runBuildApp(options: RunBuildAppOptions): Promise<Record<string, BuilderEnvironment>> {
	const environments = createBuilderEnvironments(options.config);

	const builder: ViteBuilder = {
		config: options.config,
		environments,
		build: async (environment) => {
			const environmentName = ENVIRONMENT_NAMES.find((name) => name === environment.name) ?? 'rsc';
			await buildOneEnvironment(environment, environmentName, options);
		},
	};

	const buildApp = options.container.findBuildAppHook();
	if (buildApp !== undefined) {
		await buildApp(builder);
		return environments;
	}

	// No orchestrating plugin: build each known environment once.
	for (const name of ENVIRONMENT_NAMES) {
		const environment = environments[name];
		if (environment !== undefined) {
			await builder.build(environment);
		}
	}
	return environments;
}
