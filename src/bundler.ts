import * as esbuild from 'esbuild-wasm';

// @ts-expect-error - WASM module import
import esbuildWasm from './esbuild.wasm';

let esbuildInitialized = false;
let esbuildInitializePromise: Promise<void> | null = null;

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
			esbuildInitializePromise = null;
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

export interface TransformResult {
	code: string;
	map?: string;
}

export async function transformCode(code: string, filename: string, options?: { sourcemap?: boolean }): Promise<TransformResult> {
	await initializeEsbuild();

	const loader = getLoader(filename);

	const result = await esbuild.transform(code, {
		loader,
		sourcefile: filename,
		sourcemap: options?.sourcemap ? 'inline' : false,
		format: 'esm',
		target: 'es2022',
	});

	return {
		code: result.code,
		map: result.map || undefined,
	};
}

export interface BundleOptions {
	files: Record<string, string>;
	entryPoint: string;
	externals?: string[];
	minify?: boolean;
	sourcemap?: boolean;
}

export interface BundleResult {
	code: string;
	map?: string;
	warnings?: string[];
}

function resolveRelativePath(resolveDir: string, relativePath: string, files: Record<string, string>): string | undefined {
	const dir = resolveDir.replace(/^\//, '');
	const parts = dir ? dir.split('/') : [];
	const relParts = relativePath.split('/');

	for (const part of relParts) {
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
	for (const ext of extensions) {
		if (resolved + ext in files) {
			return resolved + ext;
		}
	}

	for (const ext of extensions) {
		const indexPath = `${resolved}/index${ext}`;
		if (indexPath in files) {
			return indexPath;
		}
	}

	return undefined;
}

export async function bundleCode(options: BundleOptions): Promise<BundleResult> {
	await initializeEsbuild();

	const { files, entryPoint, externals = [], minify = false, sourcemap = false } = options;

	const virtualFsPlugin: esbuild.Plugin = {
		name: 'virtual-fs',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (args) => {
				if (args.kind === 'entry-point') {
					return { path: args.path, namespace: 'virtual' };
				}

				if (args.path.startsWith('.')) {
					const resolved = resolveRelativePath(args.resolveDir, args.path, files);
					if (resolved) {
						return { path: resolved, namespace: 'virtual' };
					}
				}

				if (!args.path.startsWith('/') && !args.path.startsWith('.')) {
					if (externals.includes(args.path) || externals.some((e) => args.path.startsWith(`${e}/`))) {
						return { path: args.path, external: true };
					}
					return { path: args.path, external: true };
				}

				const normalizedPath = args.path.startsWith('/') ? args.path.slice(1) : args.path;
				if (normalizedPath in files) {
					return { path: normalizedPath, namespace: 'virtual' };
				}

				return { path: args.path, external: true };
			});

			build.onLoad({ filter: /.*/, namespace: 'virtual' }, (args) => {
				const content = files[args.path];
				if (content === undefined) {
					return { errors: [{ text: `File not found: ${args.path}` }] };
				}

				const loader = getLoader(args.path);
				const lastSlash = args.path.lastIndexOf('/');
				const resolveDir = lastSlash >= 0 ? args.path.slice(0, lastSlash) : '';
				return { contents: content, loader, resolveDir };
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
