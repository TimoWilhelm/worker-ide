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
 * Bundle multiple files into a single JavaScript bundle using esbuild.
 */
export async function bundleCode(options: BundleOptions): Promise<BundleResult> {
	await initializeEsbuild();

	const { files, entryPoint, externals = [], minify = false, sourcemap = false, tsconfigRaw } = options;

	const virtualFsPlugin: esbuild.Plugin = {
		name: 'virtual-fs',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (arguments_) => {
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

				const loader = getLoader(arguments_.path);
				const lastSlash = arguments_.path.lastIndexOf('/');
				const resolveDirectory = lastSlash === -1 ? '' : arguments_.path.slice(0, lastSlash);
				return { contents: content, loader, resolveDir: resolveDirectory };
			});
		},
	};

	const result = await esbuild.build({
		entryPoints: [entryPoint],
		bundle: true,
		write: false,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		minify,
		sourcemap: sourcemap ? 'inline' : false,
		plugins: [virtualFsPlugin],
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
