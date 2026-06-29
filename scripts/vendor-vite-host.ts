/**
 * Vendor the native Vite plugins (vinext + @vitejs/plugin-rsc) into a single,
 * workerd-compatible ESM artifact for the Vite Surface Host.
 *
 * The host runs these plugins inside a workerd isolate, where neither the real
 * Vite package nor a Node filesystem exists. This script bundles the plugin
 * factories with our shims aliased in:
 *
 *   - `vite`                  → worker/services/vite-host/vite-shim
 *   - `vite/module-runner`    → stub (host supplies its own runner)
 *   - `node:fs` / `…/promises`→ in-memory project filesystem facade
 *   - node built-ins workerd lacks (child_process, http, os, …) → throwing stub
 *
 * `react*` and `react-server-dom-webpack/*` are left external; they are provided
 * by the server runtime isolate. The output is committed to the repo and shipped
 * with the IDE so project builds use one pinned, audited plugin version.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { build } from 'esbuild';

const ROOT = path.resolve(import.meta.dirname, '..');
const VITE_HOST = path.join(ROOT, 'worker/services/vite-host');
const OUTPUT_DIRECTORY = path.join(ROOT, 'auxiliary/vite-host/vendor');
const OUTPUT_FILE = path.join(OUTPUT_DIRECTORY, 'native-plugins.mjs');
const RUNTIME_FILE = path.join(OUTPUT_DIRECTORY, 'vinext-runtime.js');

/** Deterministic virtual directory vinext resolves its runtime modules against. */
const VINEXT_RUNTIME_DIRNAME = '/__vinext__/dist';

/** Node built-ins workerd provides via nodejs_compat — externalised as `node:`. */
const PROVIDED_NODE_BUILTINS = new Set([
	'crypto',
	'path',
	'url',
	'util',
	'assert',
	'async_hooks',
	'stream',
	'events',
	'buffer',
	'string_decoder',
	'module',
	'process',
	'querystring',
	'perf_hooks',
	'zlib',
	'diagnostics_channel',
]);

/** Node built-ins workerd lacks — replaced with a throwing stub. */
const STUBBED_NODE_BUILTINS = new Set([
	'child_process',
	'http',
	'https',
	'http2',
	'net',
	'tls',
	'worker_threads',
	'cluster',
	'dns',
	'tty',
	'readline',
	'repl',
	'inspector',
	'v8',
	'vm',
]);

const ENTRY = `
export { default as vinext } from "vinext";
export { default as rsc } from "@vitejs/plugin-rsc";
`;

type EsbuildPlugin = NonNullable<Parameters<typeof build>[0]['plugins']>[number];

function aliasPlugin(): EsbuildPlugin {
	const viteShim = path.join(VITE_HOST, 'vite-shim/index.ts');
	const moduleRunnerStub = path.join(VITE_HOST, 'runtime/vite-module-runner-stub.ts');
	const nodeFs = path.join(VITE_HOST, 'node-fs/node-fs.ts');
	const nodeFsPromises = path.join(VITE_HOST, 'node-fs/node-fs-promises.ts');
	const esModuleLexer = path.join(VITE_HOST, 'runtime/es-module-lexer-shim.ts');
	const nodeOs = path.join(VITE_HOST, 'runtime/node-os-shim.ts');
	const nodeModule = path.join(VITE_HOST, 'runtime/node-module-shim.ts');
	const optionalUnavailable = path.join(VITE_HOST, 'runtime/optional-dependency-unavailable.ts');

	const exact = new Map<string, string>([
		['vite', viteShim],
		['vite/module-runner', moduleRunnerStub],
		['fs', nodeFs],
		['node:fs', nodeFs],
		['fs/promises', nodeFsPromises],
		['node:fs/promises', nodeFsPromises],
		['es-module-lexer', esModuleLexer],
		['os', nodeOs],
		['node:os', nodeOs],
		['module', nodeModule],
		['node:module', nodeModule],
		// Optional dependencies vinext dynamically imports and gracefully skips.
		['@mdx-js/rollup', optionalUnavailable],
	]);

	const STUB_NAMESPACE = 'vite-host-builtin-stub';

	return {
		name: 'vite-host-alias',
		setup(buildApi) {
			buildApi.onResolve({ filter: /.*/ }, (arguments_) => {
				const target = exact.get(arguments_.path);
				if (target !== undefined) {
					return { path: target };
				}
				const bareName = arguments_.path.replace(/^node:/, '');
				const baseName = bareName.split('/')[0];
				if (STUBBED_NODE_BUILTINS.has(baseName)) {
					return { path: bareName, namespace: STUB_NAMESPACE };
				}
				if (PROVIDED_NODE_BUILTINS.has(baseName)) {
					return { path: `node:${bareName}`, external: true };
				}
				return;
			});

			// vinext loads peer plugins via `import(pathToFileURL(resolvedPath).href)`,
			// a Node filesystem pattern that cannot resolve in workerd. Rewrite those
			// three sites to literal specifiers so esbuild bundles the peers in and
			// they resolve at runtime. The `node:module` shim makes vinext's
			// "is it installed?" guards pass for the same peers.
			buildApi.onLoad({ filter: /vinext[\\/]dist[\\/]index\.js$/ }, async (arguments_) => {
				const { readFile } = await import('node:fs/promises');
				let source = await readFile(arguments_.path, 'utf8');
				const rewrites: Array<[RegExp, string]> = [
					[/import\(\s*pathToFileURL\w*\(\s*resolvedReactPath\s*\)\.href\s*\)/g, 'import("@vitejs/plugin-react")'],
					[/import\(\s*pathToFileURL\w*\(\s*resolvedRscPath\s*\)\.href\s*\)/g, 'import("@vitejs/plugin-rsc")'],
					[/import\(\s*pathToFileURL\w*\(\s*resolvedRscTransformsPath\s*\)\.href\s*\)/g, 'import("@vitejs/plugin-rsc/transforms")'],
				];
				for (const [pattern, replacement] of rewrites) {
					if (!pattern.test(source)) {
						throw new Error(`[vendor-vite-host] expected dynamic-import pattern not found: ${pattern}`);
					}
					source = source.replace(pattern, replacement);
				}
				return { contents: source, loader: 'js', resolveDir: path.dirname(arguments_.path) };
			});

			// CommonJS stub so any named import (spawn, IncomingMessage, …) resolves
			// via CJS interop and throws only if actually called.
			buildApi.onLoad({ filter: /.*/, namespace: STUB_NAMESPACE }, (arguments_) => ({
				contents: `
					const name = ${JSON.stringify(arguments_.path)};
					module.exports = new Proxy(function(){}, {
						get(target, property) {
							if (property === '__esModule') return true;
							return function() {
								throw new Error('Node built-in "' + name + '.' + String(property) + '" is unavailable in the Vite Surface Host runtime');
							};
						},
						apply() {
							throw new Error('Node built-in "' + name + '" is unavailable in the Vite Surface Host runtime');
						},
					});
				`,
				loader: 'js',
			}));
		},
	};
}

const VINEXT_RUNTIME_EXTENSIONS = new Set(['.js', '.ts', '.tsx', '.json']);

/** Recursively collect `relativePath -> contents` for vinext runtime source. */
function collectJsFiles(directory: string, baseDirectory: string, accumulator: Record<string, string>): void {
	for (const entry of readdirSync(directory)) {
		const absolute = path.join(directory, entry);
		if (statSync(absolute).isDirectory()) {
			collectJsFiles(absolute, baseDirectory, accumulator);
		} else if (VINEXT_RUNTIME_EXTENSIONS.has(path.extname(entry)) && !entry.endsWith('.d.ts')) {
			accumulator[path.relative(baseDirectory, absolute).split(path.sep).join('/')] = readFileSync(absolute, 'utf8');
		}
	}
}

/**
 * Embed vinext's `dist` runtime source so the host can seed it into the
 * in-memory filesystem. The generated RSC/SSR/client entries import these
 * modules by absolute path (derived from the pinned runtime dirname), and
 * esbuild bundles them into the per-environment output.
 */
function writeVinextRuntimeMap(): void {
	const distributionDirectory = path.join(ROOT, 'node_modules/vinext/dist');
	const files: Record<string, string> = {};
	collectJsFiles(distributionDirectory, distributionDirectory, files);
	const banner = '/* AUTO-GENERATED by scripts/vendor-vite-host.ts — do not edit. */\n';
	writeFileSync(RUNTIME_FILE, `${banner}export default ${JSON.stringify(files)};\n`);
	// Colocated declaration so TypeScript (and the typed ESLint parser) type the
	// import without loading the multi-MB data file into the program.
	writeFileSync(RUNTIME_FILE.replace(/\.js$/, '.d.ts'), `${banner}declare const files: Record<string, string>;\nexport default files;\n`);
	const totalBytes = Object.values(files).reduce((sum, content) => sum + content.length, 0);

	console.log(
		`[vendor-vite-host] wrote ${path.relative(ROOT, RUNTIME_FILE)} (${Object.keys(files).length} files, ${Math.round(totalBytes / 1024)} KB)`,
	);
}

const NODE_MODULES_FILE = path.join(OUTPUT_DIRECTORY, 'node-modules.js');
const NODE_MODULES_DEVELOPMENT_FILE = path.join(OUTPUT_DIRECTORY, 'node-modules-development.js');

/**
 * `*.development.js` React/RSC builds. These are only resolved by the PREVIEW
 * client build (`NODE_ENV=development`, where React DOM ships its Fast Refresh
 * renderer helpers). A production deploy build runs `NODE_ENV=production`, so
 * the `require('./cjs/*.development.js')` branch is dead-code-eliminated and
 * these files are never read. Splitting them into their own vendored map lets
 * the deploy build skip seeding ~7 MB of source that would otherwise sit
 * resident in its 128 MB isolate for no purpose.
 */
const DEVELOPMENT_VENDOR_FILE = /\.development\.(js|cjs|mjs)$/;

/**
 * Packages whose *source* is vendored into a virtual `node_modules`, so the
 * esbuild bridge can resolve them with per-environment export conditions
 * (`react-server` for RSC) and bundle the real source — letting esbuild handle
 * CommonJS↔ESM interop natively and inline one correctly-conditioned React
 * instance per environment.
 */
const VENDORED_NODE_MODULES = ['react', 'react-dom', 'scheduler', 'react-server-dom-webpack', '@vitejs/plugin-rsc'];

const VENDOR_FILE_EXTENSIONS = new Set(['.js', '.cjs', '.mjs', '.json']);

// Profiling builds are never used. The DEVELOPMENT builds ARE vendored: the
// vinext preview's client is built with `NODE_ENV=development` so React DOM
// ships its Fast Refresh renderer helpers (`scheduleRefresh`/`setRefreshHandler`),
// without which client-component HMR silently no-ops. Server/deploy builds stay
// `NODE_ENV=production` and esbuild dead-code-eliminates the dev branches.
const EXCLUDED_VENDOR_FILE = /\.profiling\./;

function collectPackageFiles(packageName: string, accumulator: Record<string, string>): void {
	const packageRoot = path.join(ROOT, 'node_modules', packageName);
	const walk = (directory: string): void => {
		for (const entry of readdirSync(directory)) {
			const absolute = path.join(directory, entry);
			if (statSync(absolute).isDirectory()) {
				walk(absolute);
				continue;
			}
			if (!VENDOR_FILE_EXTENSIONS.has(path.extname(entry)) || EXCLUDED_VENDOR_FILE.test(entry)) {
				continue;
			}
			const key = `node_modules/${packageName}/${path.relative(packageRoot, absolute).split(path.sep).join('/')}`;
			accumulator[key] = readFileSync(absolute, 'utf8');
		}
	};
	walk(packageRoot);
}

/** Write a vendored `node_modules` map file (+ its `.d.ts`) and log its size. */
function writeNodeModulesMap(outputFile: string, files: Record<string, string>, label: string): void {
	const banner = '/* AUTO-GENERATED by scripts/vendor-vite-host.ts — do not edit. */\n';
	writeFileSync(outputFile, `${banner}export default ${JSON.stringify(files)};\n`);
	writeFileSync(outputFile.replace(/\.js$/, '.d.ts'), `${banner}declare const files: Record<string, string>;\nexport default files;\n`);
	const bytes = Object.values(files).reduce((sum, content) => sum + content.length, 0);
	console.log(
		`[vendor-vite-host] wrote ${path.relative(ROOT, outputFile)} (${label}: ${Object.keys(files).length} files, ${Math.round(bytes / 1024)} KB)`,
	);
}

/**
 * Embed the React + RSC package source as a virtual `node_modules` map. Seeded
 * into the in-memory filesystem at build time and resolved by the esbuild bridge
 * via `package-resolver` with per-environment conditions.
 *
 * The output is split into a base map (production + shared source, always
 * seeded) and a development-only map (`*.development.js`, seeded only for the
 * preview build) so deploy isolates never carry the ~7 MB of dev React builds.
 */
function writeNodeModulesPackages(): void {
	const allFiles: Record<string, string> = {};
	for (const packageName of VENDORED_NODE_MODULES) {
		collectPackageFiles(packageName, allFiles);
	}
	const baseFiles: Record<string, string> = {};
	const developmentFiles: Record<string, string> = {};
	for (const [key, contents] of Object.entries(allFiles)) {
		(DEVELOPMENT_VENDOR_FILE.test(key) ? developmentFiles : baseFiles)[key] = contents;
	}
	writeNodeModulesMap(NODE_MODULES_FILE, baseFiles, 'base');
	writeNodeModulesMap(NODE_MODULES_DEVELOPMENT_FILE, developmentFiles, 'development-only');
}

/**
 * `@vitejs/plugin-rsc` evaluates the static literal arguments of
 * `import.meta.viteRsc.loadModule(...)` (and a few similar markers) with
 * `new Function(...)()`. workerd forbids code generation from strings, so that
 * throws at build time in the host worker isolate. Replace `evalValue` with an
 * acorn-based static evaluator (the bundle already exposes `parseAst`) that
 * supports the literal forms plugin-rsc produces — no code-gen required.
 */
function patchEvalValue(source: string): string {
	const safeEvalValue = `function evalValue(rawValue) {
	const program = parseAst("(" + rawValue + ")");
  const statement = program.body[0];
  const evalNode = (node) => {
    if (!node) return undefined;
    switch (node.type) {
      case "Literal": return node.value;
      case "ArrayExpression": return node.elements.map(evalNode);
      case "ObjectExpression": {
        const object = {};
        for (const property of node.properties) {
          const key = property.key.type === "Identifier" ? property.key.name : property.key.value;
          object[key] = evalNode(property.value);
        }
        return object;
      }
      case "UnaryExpression": {
        const value = evalNode(node.argument);
        if (node.operator === "-") return -value;
        if (node.operator === "+") return +value;
        if (node.operator === "!") return !value;
        return value;
      }
      case "TemplateLiteral":
        if (node.expressions.length === 0) return node.quasis[0].value.cooked;
        break;
      case "SequenceExpression": return node.expressions.map(evalNode).at(-1);
      case "Identifier": if (node.name === "undefined") return undefined; break;
    }
    throw new Error("[vinext] unsupported static expression: " + node.type);
  };
  return evalNode(statement.expression);
}`;
	const pattern = /function evalValue\(rawValue\) \{[\s\S]*?\n\}/;
	if (!pattern.test(source)) {
		throw new Error('[vendor-vite-host] could not find evalValue() to patch — plugin-rsc internals may have changed.');
	}
	return source.replace(pattern, safeEvalValue);
}

/**
 * Redirect the browser's client-reference map to DEV URLs for HMR.
 *
 * In build mode plugin-rsc bundles each `"use client"` module into a group
 * chunk and maps `referenceKey → () => import(group).export`. For module-level
 * React Fast Refresh the browser must instead load each client component
 * UNBUNDLED so it can be hot-swapped. When the async-scoped host-dev flag
 * (`globalThis.__VINEXT_HOST_DEV__`, defined by the host) is set, emit
 * `referenceKey → () => import("/@vinext-client/<relativeId>")`; those URLs are
 * served, transformed + React-Refresh-wrapped, by the host's dev module server.
 *
 * SSR/RSC stay full build mode (they render client components from the built
 * bundle, no eval), so only the browser's resolution changes — the RSC stream's
 * reference keys are unchanged.
 */
function patchClientReferences(source: string): string {
	// vinext's `vinext:rsc-client-reference-loaders` transform (enforce:'post')
	// regenerates the client-references map via `generateDirectClientReferenceLoaders`,
	// overriding plugin-rsc's own output. Patch the import target there: in
	// host-dev mode, the CLIENT build loads USER `"use client"` modules from the
	// dev module server (`/@vinext-client/…`, unbundled → React Fast Refresh).
	//
	// Crucially this applies to the CLIENT environment ONLY — the SSR/RSC bundles
	// run in the LOADER isolate (no dev server, no eval) and must keep resolving
	// client components from the bundle, so they pass `useDevUrls = false`.
	const importAnchor = '    const importId = withResolvedIdProxy(meta.importId);';
	const signatureAnchor = 'function generateDirectClientReferenceLoaders(metas) {';
	const callAnchor = 'code: generateDirectClientReferenceLoaders(metas),';
	for (const anchor of [importAnchor, signatureAnchor, callAnchor]) {
		if (!source.includes(anchor)) {
			throw new Error(
				`[vendor-vite-host] could not find client-references anchor to patch (${anchor}) — vinext internals may have changed.`,
			);
		}
	}
	return source
		.replace(signatureAnchor, 'function generateDirectClientReferenceLoaders(metas, useDevUrls) {')
		.replace(callAnchor, 'code: generateDirectClientReferenceLoaders(metas, this.environment.name === "client"),')
		.replace(
			importAnchor,
			`    const __vinextIsUserModule = !meta.importId.includes("/__vinext__/") && !meta.importId.includes("/node_modules/");
    const importId = useDevUrls && globalThis.__VINEXT_HOST_DEV__ && __vinextIsUserModule ? "/@vinext-client/" + encodeURIComponent(meta.importId) : withResolvedIdProxy(meta.importId);`,
		);
}

async function main(): Promise<void> {
	mkdirSync(OUTPUT_DIRECTORY, { recursive: true });
	const entryPath = path.join(OUTPUT_DIRECTORY, '.entry.mjs');
	writeFileSync(entryPath, ENTRY);

	const result = await build({
		entryPoints: [entryPath],
		bundle: true,
		format: 'esm',
		platform: 'neutral',
		target: 'es2022',
		mainFields: ['module', 'main'],
		conditions: ['workerd', 'module', 'import', 'default'],
		// Pin vinext's runtime-path computation to a deterministic virtual root.
		// vinext derives its shim/server runtime module paths from
		// `import.meta.dirname`; fixing it lets the host seed those files at a
		// known location in the in-memory filesystem (independent of where the
		// bundle physically lives on disk or in the isolate).
		define: {
			'import.meta.dirname': JSON.stringify(VINEXT_RUNTIME_DIRNAME),
			'import.meta.url': JSON.stringify(`file://${VINEXT_RUNTIME_DIRNAME}/native-plugins.mjs`),
		},
		external: [
			'react',
			'react-dom',
			'react/*',
			'react-dom/*',
			'react-server-dom-webpack',
			'react-server-dom-webpack/*',
			// Optional Babel presets referenced by @babel/core's config loader but
			// never used by the React plugin's JSX + Fast Refresh transform.
			'@babel/preset-typescript',
			'@babel/preset-typescript/*',
			'@babel/preset-flow',
			'@babel/preset-flow/*',
		],
		plugins: [aliasPlugin()],
		// vinext + plugin-rsc pull in CommonJS dependencies that call
		// `require("node:path")` etc. Bundled to ESM, esbuild routes those through
		// its `__require` shim, which throws ("Dynamic require ... not supported")
		// unless a real `require` exists. Give the bundle one via `createRequire`
		// so node builtins resolve in workerd (with `nodejs_compat`) — the host
		// worker isolate has no global `require` otherwise.
		banner: {
			js: "import { createRequire as __vinextCreateRequire } from 'node:module'; var require = /* @__PURE__ */ __vinextCreateRequire('file:///native-plugins.mjs');",
		},
		legalComments: 'none',
		logLevel: 'warning',
		write: false,
		metafile: true,
	});

	rmSync(entryPath, { force: true });

	const output = patchClientReferences(patchEvalValue(result.outputFiles[0].text));
	const banner = '/* AUTO-GENERATED by scripts/vendor-vite-host.ts — do not edit. */\n';
	writeFileSync(OUTPUT_FILE, banner + output);

	// The .mjs has no inline types; without a declaration TS would type-infer
	// from its 4.9MB source (and surface its `null` plugin slots). Declare the
	// public surface the host consumes instead.
	writeFileSync(
		OUTPUT_FILE.replace(/\.mjs$/, '.d.mts'),
		`${banner}import type { PluginOption } from '@server/services/vite-host/types';\nexport function vinext(options?: Record<string, unknown>): PluginOption[];\nexport function rsc(options?: Record<string, unknown>): PluginOption[];\n`,
	);

	const vinextVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/vinext/package.json'), 'utf8')).version;
	const rscVersion = JSON.parse(readFileSync(path.join(ROOT, 'node_modules/@vitejs/plugin-rsc/package.json'), 'utf8')).version;
	writeFileSync(
		`${OUTPUT_FILE}.versions.json`,
		JSON.stringify({ vinext: vinextVersion, '@vitejs/plugin-rsc': rscVersion }, undefined, 2) + '\n',
	);

	const sizeKb = Math.round(output.length / 1024);

	console.log(
		`[vendor-vite-host] wrote ${path.relative(ROOT, OUTPUT_FILE)} (${sizeKb} KB; vinext@${vinextVersion}, @vitejs/plugin-rsc@${rscVersion})`,
	);

	writeVinextRuntimeMap();
	writeNodeModulesPackages();
}

await main();
