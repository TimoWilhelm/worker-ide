/**
 * Bundler Service.
 * Handles TypeScript/JSX transformation and bundling via esbuild-wasm.
 */

import * as esbuild from 'esbuild-wasm';

// @ts-expect-error - WASM module import
import esbuildWasm from '../../vendor/esbuild.wasm';

let esbuildInitialized = false;
let esbuildInitializePromise: Promise<void> | undefined;

async function initializeEsbuild(): Promise<void> {
	if (esbuildInitialized) return;

	if (esbuildInitializePromise) {
		return esbuildInitializePromise;
	}

	esbuildInitializePromise = (async () => {
		try {
			await esbuild.initialize({
				wasmModule: esbuildWasm,
				worker: false,
			});
			esbuildInitialized = true;
		} catch (error) {
			if (error instanceof Error && error.message.includes('Cannot call "initialize" more than once')) {
				esbuildInitialized = true;
				return;
			}
			esbuildInitializePromise = undefined;
			throw error;
		}
	})();

	return esbuildInitializePromise;
}

function getLoader(path: string): esbuild.Loader {
	if (path.endsWith('.ts') || path.endsWith('.mts')) return 'ts';
	if (path.endsWith('.tsx')) return 'tsx';
	if (path.endsWith('.jsx')) return 'jsx';
	if (path.endsWith('.json')) return 'json';
	if (path.endsWith('.css')) return 'css';
	return 'js';
}

// =============================================================================
// Transform Types
// =============================================================================

export interface TransformResult {
	code: string;
	map?: string;
}

export interface TransformOptions {
	sourcemap?: boolean;
	tsconfigRaw?: string;
}

// =============================================================================
// Transform Function
// =============================================================================

/**
 * Transform TypeScript/JSX code to JavaScript using esbuild.
 */
export async function transformCode(code: string, filename: string, options?: TransformOptions): Promise<TransformResult> {
	await initializeEsbuild();

	const loader = getLoader(filename);

	const result = await esbuild.transform(code, {
		loader,
		sourcefile: filename,
		sourcemap: options?.sourcemap ? 'inline' : false,
		format: 'esm',
		target: 'es2022',
		tsconfigRaw: options?.tsconfigRaw,
	});

	return {
		code: result.code,
		map: result.map || undefined,
	};
}

// =============================================================================
// Bundle Types
// =============================================================================

export interface BundleOptions {
	files: Record<string, string>;
	entryPoint: string;
	externals?: string[];
	minify?: boolean;
	sourcemap?: boolean;
	tsconfigRaw?: string;
}

export interface BundleResult {
	code: string;
	map?: string;
	warnings?: string[];
}

// =============================================================================
// ESM CDN Resolution
// =============================================================================

const ESM_CDN = 'https://esm.sh';

/** In-memory cache for modules fetched from esm.sh. */
const esmCdnCache = new Map<string, string>();

/**
 * Fetch a module from esm.sh, following redirects, and cache the result.
 */
async function fetchFromCdn(url: string): Promise<string> {
	const cached = esmCdnCache.get(url);
	if (cached !== undefined) return cached;

	const response = await fetch(url, { redirect: 'follow' });
	if (!response.ok) {
		throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
	}
	const text = await response.text();

	// Cache both the original URL and the final URL (after redirects)
	esmCdnCache.set(url, text);
	if (response.url !== url) {
		esmCdnCache.set(response.url, text);
	}

	return text;
}

/**
 * Resolve a URL relative to a base URL (for esm.sh internal imports).
 */
function resolveUrl(base: string, relative: string): string {
	try {
		return new URL(relative, base).href;
	} catch {
		return relative;
	}
}

/**
 * esbuild plugin that resolves bare package imports via esm.sh CDN.
 * Fetches and inlines the module source at bundle time.
 */
function createEsmCdnPlugin(): esbuild.Plugin {
	return {
		name: 'esm-cdn',
		setup(build) {
			// Resolve bare specifiers to esm.sh URLs
			build.onResolve({ filter: /.*/, namespace: 'esm-cdn' }, (arguments_) => {
				// Relative imports within esm.sh modules
				if (arguments_.path.startsWith('.') || arguments_.path.startsWith('/')) {
					return {
						path: resolveUrl(arguments_.importer, arguments_.path),
						namespace: 'esm-cdn',
					};
				}
				// Bare specifiers within esm.sh (transitive deps)
				return {
					path: `${ESM_CDN}/${arguments_.path}`,
					namespace: 'esm-cdn',
				};
			});

			// Load modules from esm.sh
			build.onLoad({ filter: /.*/, namespace: 'esm-cdn' }, async (arguments_) => {
				const source = await fetchFromCdn(arguments_.path);
				return { contents: source, loader: 'js' };
			});
		},
	};
}

// =============================================================================
// Bundle Function
// =============================================================================

function resolveRelativePath(resolveDirectory: string, relativePath: string, files: Record<string, string>): string | undefined {
	const directory = resolveDirectory.replace(/^\//, '');
	const parts = directory ? directory.split('/') : [];
	const relativeParts = relativePath.split('/');

	for (const part of relativeParts) {
		if (part === '..') {
			parts.pop();
		} else if (part !== '.') {
			parts.push(part);
		}
	}

	const resolved = parts.join('/');

	if (resolved in files) {
		return resolved;
	}

	const extensions = ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs'];
	for (const extension of extensions) {
		if (resolved + extension in files) {
			return resolved + extension;
		}
	}

	for (const extension of extensions) {
		const indexPath = `${resolved}/index${extension}`;
		if (indexPath in files) {
			return indexPath;
		}
	}

	return undefined;
}

/**
 * Create a virtual-fs esbuild plugin for bundling files from a Record.
 * When `resolveBareFromCdn` is true, bare specifiers are sent to the esm-cdn namespace
 * instead of being marked as external.
 */
function createVirtualFsPlugin(
	files: Record<string, string>,
	externals: string[],
	resolveBareFromCdn: boolean,
	knownDependencies?: Map<string, string>,
): esbuild.Plugin {
	return {
		name: 'virtual-fs',
		setup(build) {
			// Only handle imports from the virtual namespace or entry points.
			// Imports from esm-cdn namespace are handled by the esm-cdn plugin.
			build.onResolve({ filter: /.*/ }, (arguments_) => {
				// Let the esm-cdn plugin handle its own namespace
				if (arguments_.namespace === 'esm-cdn') return;

				if (arguments_.kind === 'entry-point') {
					return { path: arguments_.path, namespace: 'virtual' };
				}

				if (arguments_.path.startsWith('.')) {
					const resolved = resolveRelativePath(arguments_.resolveDir, arguments_.path, files);
					if (resolved) {
						return { path: resolved, namespace: 'virtual' };
					}
				}

				if (!arguments_.path.startsWith('/') && !arguments_.path.startsWith('.')) {
					if (externals.includes(arguments_.path) || externals.some((error) => arguments_.path.startsWith(`${error}/`))) {
						return { path: arguments_.path, external: true };
					}
					if (resolveBareFromCdn) {
						const parts = arguments_.path.split('/');
						const packageName = parts[0].startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
						const subpath = parts[0].startsWith('@') ? parts.slice(2).join('/') : parts.slice(1).join('/');

						// Only resolve imports that are registered as dependencies
						if (knownDependencies) {
							const version = knownDependencies.get(packageName);
							if (version === undefined) {
								return {
									errors: [
										{
											text: `Unregistered dependency "${packageName}". Add it to project dependencies using the Dependencies panel.`,
										},
									],
								};
							}
							// Use the registered version in the esm.sh URL
							const versionedPackage = version && version !== '*' ? `${packageName}@${version}` : packageName;
							const cdnPath = subpath ? `${versionedPackage}/${subpath}` : versionedPackage;
							return {
								path: `${ESM_CDN}/${cdnPath}`,
								namespace: 'esm-cdn',
							};
						}

						// No dependency list provided — resolve all bare imports (legacy/fallback)
						return {
							path: `${ESM_CDN}/${arguments_.path}`,
							namespace: 'esm-cdn',
						};
					}
					return { path: arguments_.path, external: true };
				}

				const normalizedPath = arguments_.path.startsWith('/') ? arguments_.path.slice(1) : arguments_.path;
				if (normalizedPath in files) {
					return { path: normalizedPath, namespace: 'virtual' };
				}

				return { path: arguments_.path, external: true };
			});

			build.onLoad({ filter: /.*/, namespace: 'virtual' }, (arguments_) => {
				const content = files[arguments_.path];
				if (content === undefined) {
					return { errors: [{ text: `File not found: ${arguments_.path}` }] };
				}

				// Convert CSS imports to JS that injects a <style> tag
				if (arguments_.path.endsWith('.css')) {
					const cssContent = JSON.stringify(content);
					const jsCode = [
						`const css = ${cssContent};`,
						`const style = document.createElement('style');`,
						`style.setAttribute('data-dev-id', ${JSON.stringify(arguments_.path)});`,
						`style.textContent = css;`,
						`document.head.appendChild(style);`,
						`export default css;`,
					].join('\n');
					return { contents: jsCode, loader: 'js' };
				}

				const loader = getLoader(arguments_.path);
				const lastSlash = arguments_.path.lastIndexOf('/');
				const resolveDirectory = lastSlash === -1 ? '' : arguments_.path.slice(0, lastSlash);
				return { contents: content, loader, resolveDir: resolveDirectory };
			});
		},
	};
}

/**
 * Bundle multiple files into a single JavaScript bundle using esbuild.
 */
export async function bundleCode(options: BundleOptions): Promise<BundleResult> {
	await initializeEsbuild();

	const { files, entryPoint, externals = [], minify = false, sourcemap = false, tsconfigRaw } = options;

	const result = await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify,
		sourcemap: sourcemap ? 'inline' : false,
		plugins: [createVirtualFsPlugin(files, externals, false)],
		outfile: 'bundle.js',
		tsconfigRaw,
	});

	const output = result.outputFiles?.[0];
	if (!output) {
		throw new Error('No output generated from esbuild');
	}

	return {
		code: output.text,
		warnings: result.warnings.map((w) => w.text),
	};
}

// =============================================================================
// Bundle with CDN Types
// =============================================================================

export interface BundleWithCdnOptions {
	files: Record<string, string>;
	entryPoint: string;
	externals?: string[];
	minify?: boolean;
	sourcemap?: boolean;
	tsconfigRaw?: string;
	platform?: 'browser' | 'neutral';
	/** Known registered dependencies (name → version). Only these are resolved from esm.sh. */
	knownDependencies?: Map<string, string>;
}

/**
 * Bundle files into a single JavaScript module, resolving bare package imports
 * from esm.sh CDN at bundle time. Used for both frontend (React) and backend (Hono).
 */
export async function bundleWithCdn(options: BundleWithCdnOptions): Promise<BundleResult> {
	await initializeEsbuild();

	const {
		files,
		entryPoint,
		externals = [],
		minify = false,
		sourcemap = false,
		tsconfigRaw,
		platform = 'browser',
		knownDependencies,
	} = options;

	const virtualFsPlugin = createVirtualFsPlugin(files, externals, true, knownDependencies);

	const result = await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: 'esm',
		platform,
		target: 'es2022',
		minify,
		sourcemap: sourcemap ? 'inline' : false,
		plugins: [virtualFsPlugin, createEsmCdnPlugin()],
		outfile: 'bundle.js',
		tsconfigRaw,
	});

	const output = result.outputFiles?.[0];
	if (!output) {
		throw new Error('No output generated from esbuild');
	}

	return {
		code: output.text,
		warnings: result.warnings.map((w) => w.text),
	};
}
