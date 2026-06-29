/**
 * Run a built server module set in a workerd `LOADER` isolate.
 *
 * The Vite Surface Host produces an ES module set for the server environments
 * (RSC + SSR). Because workerd forbids evaluating code from strings, that set is
 * handed to `env.LOADER`, which instantiates a real sandboxed worker from the
 * modules and returns a `Fetcher` to drive it. Runtime dependencies the build
 * left external (React, the RSC runtime, framework shims) are supplied as
 * additional modules in the set.
 */
/** A module provided to the isolate: JS source string, or a typed module. */
export type LoaderModule = string | { js: string } | { json: string } | { text: string };

export interface ServerModuleSet {
	/** Entry module name within `modules` (the worker's `main`). */
	mainModule: string;
	/** `moduleName -> source` map provided to the isolate. */
	modules: Record<string, LoaderModule>;
	compatibilityDate: string;
	compatibilityFlags?: string[];
	/** Bindings exposed to the isolate as `env`. */
	env?: Record<string, unknown>;
	/** Tail workers for log streaming. */
	tails?: Fetcher[];
}

export interface RunServerOptions {
	loader: WorkerLoader;
	/** Content-addressed cache key; the factory runs only on a new key. */
	cacheKey: string;
	moduleSet: ServerModuleSet;
}

/**
 * Convert a build output map (`relativePath -> contents`) into LOADER modules,
 * choosing the module type by extension so JSON manifests import correctly.
 */
export function serverModulesFromOutput(output: Record<string, string>): Record<string, LoaderModule> {
	const modules: Record<string, LoaderModule> = {};
	for (const [path, contents] of Object.entries(output)) {
		if (path.endsWith('.json')) {
			modules[path] = { json: contents };
		} else if (path.endsWith('.js') || path.endsWith('.mjs')) {
			modules[path] = contents;
		} else {
			modules[path] = { text: contents };
		}
	}
	return modules;
}

/** Instantiate (or fetch the cached) server isolate and return its entrypoint. */
export function getServerEntrypoint(options: RunServerOptions): Fetcher {
	const worker = options.loader.get(options.cacheKey, () => ({
		compatibilityDate: options.moduleSet.compatibilityDate,
		compatibilityFlags: options.moduleSet.compatibilityFlags,
		mainModule: options.moduleSet.mainModule,
		modules: options.moduleSet.modules,
		...(options.moduleSet.env === undefined ? {} : { env: options.moduleSet.env }),
		...(options.moduleSet.tails === undefined ? {} : { tails: options.moduleSet.tails }),
	}));
	return worker.getEntrypoint();
}
