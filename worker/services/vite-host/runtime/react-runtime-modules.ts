/**
 * Shared React runtime modules — the "extract React once" half of the
 * shared-React build.
 *
 * Historically each Vite environment (rsc/ssr/client) bundled its own copy of
 * React, react-dom and scheduler from the vendored source. That compiled React
 * up to ~5× per build (scan + real passes × environments) and forced every
 * fetched esm.sh dependency to be *inlined* so its `import "react"` could dedupe
 * into the bundle's React instance.
 *
 * This module instead compiles the React closure ONCE per environment into a set
 * of standalone ES modules, with the closure packages mutually externalised so
 * they reference each other by sibling path (a single shared instance). The app
 * bundle and standalone esm.sh dependency modules then import React from these
 * shared modules (left external at build time) rather than inlining it.
 *
 * `react-server-dom-webpack` is deliberately NOT part of the closure: plugin-rsc
 * patches its `__webpack_require__` loader during `transform`, so it must remain
 * bundled (and patched) inside the app entry — where it imports the shared React
 * via the same external sibling paths, preserving the single instance.
 *
 * The output is deterministic for a given environment + define (it depends only
 * on vendored source), so it is cached per isolate and reused across builds.
 */
import { conditionsForEnvironment } from '../conditions';
import { detectCjsExports } from './development-module-server';
import { normalizePosixPath } from '../node-fs/memory-file-system';
import { resolvePackage } from '../package-resolver';

import type { Esbuild } from '../esbuild-runtime';
import type { MemoryFileSystem } from '../node-fs/memory-file-system';
import type { ViteEnvironmentName } from '../types';
import type { Plugin as EsbuildPlugin } from 'esbuild-wasm';

/** Root (relative to an environment's outDir) the shared modules are emitted under. */
const RUNTIME_ROOT = '__react';

/**
 * Marker prefix forcing a closure specifier to be emitted as a real, external
 * ESM import. A consumer's CommonJS `require("react")` is routed through an ESM
 * re-export shim whose target carries this marker; the resolver maps it to the
 * external shared-module path, so esbuild emits a static `import` (not a
 * `__require` shim the workerd module worker cannot resolve). Exported so the
 * esbuild bridge can resolve the same marker when bundling the app graph.
 */
export const REACT_CLOSURE_EXTERNAL_MARKER = '\0vinext-react-external:';

/**
 * The shared React closure — packages compiled once and referenced by every
 * environment build as a single instance. `react-server-dom-webpack` is excluded
 * (it stays bundled + patched by plugin-rsc inside the app entry).
 */
const CLOSURE_PACKAGES: ReadonlySet<string> = new Set(['react', 'react-dom', 'scheduler']);

/** Subpaths compiled for the server environments (rsc/ssr). */
const SERVER_SUBPATHS: readonly string[] = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react/compiler-runtime',
	'react-dom',
	'react-dom/server.edge',
	'scheduler',
];

/** Subpaths compiled for the browser client environment. */
const CLIENT_SUBPATHS: readonly string[] = [
	'react',
	'react/jsx-runtime',
	'react/jsx-dev-runtime',
	'react-dom',
	'react-dom/client',
	'scheduler',
];

function subpathsForEnvironment(environment: ViteEnvironmentName): readonly string[] {
	return environment === 'client' ? CLIENT_SUBPATHS : SERVER_SUBPATHS;
}

function isClosureSpecifier(specifier: string): boolean {
	const packageName = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
	return CLOSURE_PACKAGES.has(packageName);
}

/**
 * Whether `specifier` is a React-closure import the build externalises to a
 * shared runtime module for `environment`. Only the exact subpaths emitted for
 * that environment qualify; any other closure subpath falls through to normal
 * bundling (so it can never reference a shared module that was never emitted).
 */
export function isReactClosureSpecifier(specifier: string, environment: ViteEnvironmentName): boolean {
	return subpathsForEnvironment(environment).includes(specifier);
}

/**
 * ESM re-export shim contents for a closure specifier. Bundling this (rather than
 * leaving the bare specifier external) converts a CommonJS `require("react")`
 * into a static ESM `import` of the external shared module — the only form the
 * workerd module worker can resolve. Consumed via {@link REACT_CLOSURE_EXTERNAL_MARKER}.
 */
export function reactRuntimeShimContents(specifier: string): string {
	const target = JSON.stringify(REACT_CLOSURE_EXTERNAL_MARKER + specifier);
	return `export * from ${target};\nexport { default } from ${target};\n`;
}

/** Encode an import specifier into a flat, filesystem-safe module file name. */
function encodeSpecifier(specifier: string): string {
	return specifier.replaceAll('/', '__');
}

/** The shared module's file name within an environment's outDir (e.g. `__react/ssr/react__jsx-runtime.js`). */
export function runtimeModuleFileName(environment: ViteEnvironmentName, specifier: string): string {
	return `${RUNTIME_ROOT}/${environment}/${encodeSpecifier(specifier)}.js`;
}

/**
 * The import path app/dependency code uses to reference a shared closure
 * specifier — left external at build time.
 *
 * Root-absolute (not relative) on purpose: esbuild emits this external string
 * verbatim into every chunk, but chunks land at varying depths (the entry at the
 * outDir root, code-split + per-client-reference chunks under `chunks/`). A
 * relative `./__react/…` would only resolve from the root; an absolute
 * `/__react/…` resolves identically from any chunk — in the browser (served from
 * the client output root) and in the workerd LOADER (the leading slash maps to
 * the module-set key).
 */
export function runtimeImportPath(environment: ViteEnvironmentName, specifier: string): string {
	return `/${runtimeModuleFileName(environment, specifier)}`;
}

/** The sibling import path one shared module uses to reference another (same dir). */
function siblingImportPath(specifier: string): string {
	return `./${encodeSpecifier(specifier)}.js`;
}

function loaderForPath(path: string): 'ts' | 'tsx' | 'js' | 'json' {
	const file = path.split('?')[0];
	if (file.endsWith('.tsx')) return 'tsx';
	if (file.endsWith('.ts') || file.endsWith('.mts')) return 'ts';
	if (file.endsWith('.json')) return 'json';
	return 'js';
}

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith('.') && !specifier.startsWith('/');
}

function directoryOfPath(id: string): string {
	const normalized = normalizePosixPath(id);
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? '/' : normalized.slice(0, index);
}

/**
 * esbuild plugin that bundles one closure subpath against the vendored
 * node_modules, leaving the OTHER closure specifiers external as sibling paths so
 * the emitted modules share a single instance.
 */
function createRuntimeResolverPlugin(
	fileSystem: MemoryFileSystem,
	environment: ViteEnvironmentName,
	entrySpecifier: string,
): EsbuildPlugin {
	const namespace = 'vinext-react-runtime';
	const shimNamespace = 'vinext-react-runtime-shim';
	const conditions = conditionsForEnvironment(environment);
	return {
		name: 'vinext-react-runtime-resolver',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (arguments_) => {
				if (arguments_.kind === 'entry-point') {
					const resolved = resolvePackage(arguments_.path, fileSystem, conditions);
					if (resolved === undefined) {
						return { errors: [{ text: `react runtime entry not resolvable: ${arguments_.path}` }] };
					}
					return { path: resolved.path, namespace };
				}
				// The shim's own re-export target → the external sibling module. Crossed
				// by ESM `export * from`, so esbuild emits a real `import` (a CommonJS
				// `require` would instead become a `__require` shim with no resolver in
				// the workerd module worker).
				if (arguments_.path.startsWith(REACT_CLOSURE_EXTERNAL_MARKER)) {
					return { path: siblingImportPath(arguments_.path.slice(REACT_CLOSURE_EXTERNAL_MARKER.length)), external: true };
				}
				if (arguments_.path.startsWith('node:')) {
					return { path: arguments_.path, external: true };
				}
				// A different closure specifier → an ESM re-export shim of the external
				// sibling module (shared instance). Routing CommonJS `require("react")`
				// through this shim turns the boundary into a static ESM import.
				if (isBareSpecifier(arguments_.path) && isClosureSpecifier(arguments_.path) && arguments_.path !== entrySpecifier) {
					return { path: arguments_.path, namespace: shimNamespace };
				}
				// A bare specifier for THIS package's internals (e.g. react-dom resolving
				// `react-dom` self-reference) or a non-closure dep → resolve + bundle.
				if (isBareSpecifier(arguments_.path)) {
					const resolved = resolvePackage(arguments_.path, fileSystem, conditions);
					return resolved === undefined ? { path: arguments_.path, external: true } : { path: resolved.path, namespace };
				}
				const base = arguments_.path.startsWith('/') ? arguments_.path : `${directoryOfPath(arguments_.importer)}/${arguments_.path}`;
				return { path: normalizePosixPath(base), namespace };
			});
			build.onLoad({ filter: /.*/, namespace: shimNamespace }, (arguments_) => {
				return { contents: reactRuntimeShimContents(arguments_.path), loader: 'js' };
			});
			build.onLoad({ filter: /.*/, namespace }, (arguments_) => {
				if (!fileSystem.exists(arguments_.path)) {
					return { errors: [{ text: `react runtime module not found: ${arguments_.path}` }] };
				}
				return {
					contents: fileSystem.readFileText(arguments_.path),
					loader: loaderForPath(arguments_.path),
					resolveDir: directoryOfPath(arguments_.path),
				};
			});
		},
	};
}

export interface BuildReactRuntimeOptions {
	esbuild: Esbuild;
	fileSystem: MemoryFileSystem;
	environment: ViteEnvironmentName;
	/** esbuild `define` (e.g. `process.env.NODE_ENV`). */
	define: Record<string, string>;
}

/**
 * Compile the shared React closure for an environment into standalone ES
 * modules, keyed by their outDir-relative file name (see
 * {@link runtimeModuleFileName}).
 */
export async function buildReactRuntimeModules(options: BuildReactRuntimeOptions): Promise<Record<string, string>> {
	const { esbuild, fileSystem, environment, define } = options;
	const platform = environment === 'client' ? 'browser' : 'node';
	const modules: Record<string, string> = {};

	for (const specifier of subpathsForEnvironment(environment)) {
		const resolved = resolvePackage(specifier, fileSystem, conditionsForEnvironment(environment));
		if (resolved === undefined) {
			continue;
		}
		// Re-export the CommonJS entry's named exports explicitly (Vite cjs-interop
		// style): esbuild's `export *` from a `module.exports = require('…')` entry
		// only forwards `default`, dropping named bindings React's runtimes read off
		// each other (e.g. react-dom checks react's `__SERVER_INTERNALS…`). Detecting
		// the names — following the re-export hop — restores them as ESM exports.
		const names = detectCjsExports(resolved.path, fileSystem);
		const namedReExport = names.length > 0 ? `export const { ${names.join(', ')} } = __cjs;\n` : '';
		const result = await esbuild.build({
			stdin: {
				contents: `import __cjs from ${JSON.stringify(resolved.path)};\nexport default __cjs;\n${namedReExport}`,
				resolveDir: '/',
				loader: 'js',
				sourcefile: `vinext-react-runtime-${encodeSpecifier(specifier)}.js`,
			},
			bundle: true,
			format: 'esm',
			target: 'es2022',
			platform,
			absWorkingDir: '/',
			write: false,
			logLevel: 'silent',
			define,
			plugins: [createRuntimeResolverPlugin(fileSystem, environment, specifier)],
		});
		const code = result.outputFiles?.[0]?.text;
		if (code === undefined) {
			throw new Error(`react runtime module produced no output: ${specifier}`);
		}
		modules[runtimeModuleFileName(environment, specifier)] = code;
	}

	return modules;
}

/**
 * Per-isolate cache of the shared React runtime modules. The output depends only
 * on the (immutable) vendored React source, the environment's export conditions,
 * and `NODE_ENV` — never on project source — so it is built once per isolate and
 * reused across every project build. This is the core memory/CPU win: React is
 * compiled a single time instead of being re-bundled into each environment on
 * every build pass.
 */
const runtimeModuleCache = new Map<string, Promise<Record<string, string>>>();

/** {@link buildReactRuntimeModules}, memoised per `environment + NODE_ENV` for the isolate. */
export function buildReactRuntimeModulesCached(options: BuildReactRuntimeOptions): Promise<Record<string, string>> {
	const nodeEnvironment = options.define['process.env.NODE_ENV'] ?? '"production"';
	const cacheKey = `${options.environment}:${nodeEnvironment}`;
	const cached = runtimeModuleCache.get(cacheKey);
	if (cached !== undefined) {
		return cached;
	}
	const built = buildReactRuntimeModules(options).catch((error: unknown) => {
		// A failed build must not poison the cache with a rejected promise.
		runtimeModuleCache.delete(cacheKey);
		throw error;
	});
	runtimeModuleCache.set(cacheKey, built);
	return built;
}
