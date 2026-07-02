/**
 * Dev module server for vinext HMR.
 *
 * In host development mode the build emits DEV-style client references: each
 * USER `"use client"` component is loaded by the browser from `/@vinext-client/…`
 * (see `scripts/vendor-vite-host.ts` `patchClientReferences`). This module serves
 * those requests UNBUNDLED so the browser can hot-swap a single component with
 * React Fast Refresh (state preserved):
 *
 *  - `/@vinext-client/<importId>`     → the user client module, compiled to JS,
 *    its imports rewritten to dev URLs, and wrapped with `import.meta.hot`
 *    (`__preview_hot__`) + `$RefreshReg$`/`$RefreshSig$` registrations so the
 *    legacy preview runtime can apply a surgical update.
 *  - `/@vinext-client-dep/<specifier>` → a bare dependency (React et al.) bundled
 *    to browser ESM. React is served as ONE shared module so the bundled client
 *    runtime (react-dom) and the unbundled components use the same instance.
 *
 * SSR/RSC remain fully bundled (no eval in the LOADER isolate); only the
 * browser's client-component resolution is redirected here.
 */
import { conditionsForEnvironment } from '../conditions';
import {
	buildEsmCdnUrl,
	ESM_CDN_NAMESPACE,
	fetchEsmModule,
	isEsmCdnExcluded,
	readDependencyVersions,
	resolveEsmCdnImport,
} from '../esm-cdn';
import { normalizePosixPath } from '../node-fs/memory-file-system';
import { parsePackageSpecifier, resolvePackage } from '../package-resolver';

import type { Esbuild } from '../esbuild-runtime';
import type { MemoryFileSystem } from '../node-fs/memory-file-system';
import type { Plugin as EsbuildPlugin } from 'esbuild-wasm';

const CLIENT_PREFIX = '/@vinext-client/';
const DEPENDENCY_PREFIX = '/@vinext-client-dep/';
const RESOLVABLE_EXTENSIONS = ['.tsx', '.ts', '.jsx', '.js', '.mjs', '.mts'];

export interface DevelopmentModuleContext {
	esbuild: Esbuild;
	fileSystem: MemoryFileSystem;
	/**
	 * Reads a user module's CURRENT source by project-root-relative id (e.g.
	 * `/app/counter.tsx`), or `undefined` if absent. Supplied by the preview so
	 * HMR serves freshly-edited code without a full rebuild; falls back to the
	 * build snapshot when omitted.
	 */
	readSource?: (id: string) => Promise<string | undefined>;
}

/** A served dev module (JavaScript source + content type). */
export interface DevelopmentModuleResult {
	code: string;
	contentType: string;
}

/** Whether a request path targets the dev module server. */
export function isDevelopmentModuleRequest(pathname: string): boolean {
	return pathname.startsWith(CLIENT_PREFIX) || pathname.startsWith(DEPENDENCY_PREFIX);
}

/** Map a project module id to the browser dev URL the build references it by. */
export function developmentClientUrl(importId: string): string {
	return CLIENT_PREFIX + encodeURIComponent(importId);
}

/** Serve a dev module request, or `undefined` if the path isn't a dev module. */
export async function serveDevelopmentModule(
	pathname: string,
	context: DevelopmentModuleContext,
): Promise<DevelopmentModuleResult | undefined> {
	if (pathname.startsWith(CLIENT_PREFIX)) {
		const importId = decodeURIComponent(pathname.slice(CLIENT_PREFIX.length));
		return serveClientModule(importId, context);
	}
	if (pathname.startsWith(DEPENDENCY_PREFIX)) {
		const specifier = decodeURIComponent(pathname.slice(DEPENDENCY_PREFIX.length));
		return serveDependency(specifier, context);
	}
	return undefined;
}

function directoryOf(id: string): string {
	const normalized = normalizePosixPath(id);
	const index = normalized.lastIndexOf('/');
	return index <= 0 ? '/' : normalized.slice(0, index);
}

function isBareSpecifier(specifier: string): boolean {
	return !specifier.startsWith('.') && !specifier.startsWith('/');
}

function esbuildLoader(id: string): 'ts' | 'tsx' | 'jsx' | 'js' {
	const file = id.split('?')[0];
	if (file.endsWith('.tsx')) return 'tsx';
	if (file.endsWith('.ts') || file.endsWith('.mts')) return 'ts';
	if (file.endsWith('.jsx')) return 'jsx';
	return 'js';
}

/** Resolve a relative/absolute import against the in-memory project filesystem. */
function resolveProjectModule(importer: string, specifier: string, fileSystem: MemoryFileSystem): string | undefined {
	const base = specifier.startsWith('/') ? specifier : `${directoryOf(importer)}/${specifier}`;
	const normalized = normalizePosixPath(base);
	if (fileSystem.exists(normalized) && fileSystem.stat(normalized).isFile()) {
		return normalized;
	}
	for (const extension of RESOLVABLE_EXTENSIONS) {
		if (fileSystem.exists(normalized + extension)) {
			return normalized + extension;
		}
	}
	for (const extension of RESOLVABLE_EXTENSIONS) {
		const indexPath = `${normalized}/index${extension}`;
		if (fileSystem.exists(indexPath)) {
			return indexPath;
		}
	}
	return undefined;
}

/** Map an import specifier to its dev URL, or `undefined` to leave it as-is. */
function rewriteSpecifier(specifier: string, importId: string, fileSystem: MemoryFileSystem): string | undefined {
	if (specifier.startsWith('node:') || specifier.startsWith('/@vinext-client')) {
		return undefined;
	}
	if (isBareSpecifier(specifier)) {
		return DEPENDENCY_PREFIX + encodeURIComponent(specifier);
	}
	const resolved = resolveProjectModule(importId, specifier, fileSystem);
	return resolved === undefined ? undefined : developmentClientUrl(resolved);
}

/**
 * Rewrite a client module's import specifiers to dev URLs the browser loads:
 *  - bare specifiers   → `/@vinext-client-dep/<specifier>` (bundled deps)
 *  - relative/absolute → `/@vinext-client/<resolved project id>`
 * Handles `… from '…'`, bare `import '…'`, and dynamic `import('…')`.
 */
function rewriteImports(code: string, importId: string, fileSystem: MemoryFileSystem): string {
	const replace = (match: string, prefix: string, quote: string, specifier: string): string => {
		const rewritten = rewriteSpecifier(specifier, importId, fileSystem);
		return rewritten === undefined ? match : `${prefix}${quote}${rewritten}${quote}`;
	};
	return code
		.replaceAll(/(\bfrom\s*)(["'])([^"']+)\2/g, replace)
		.replaceAll(/(\bimport\s+)(["'])([^"']+)\2/g, replace)
		.replaceAll(/(\bimport\s*\(\s*)(["'])([^"']+)\2/g, replace);
}

const COMPONENT_NAME = /^[A-Z]/;

/** Detect top-level PascalCase exports to register as React Refresh families. */
function detectExportedComponents(code: string): string[] {
	const names = new Set<string>();
	for (const match of code.matchAll(/\bexport\s+(?:async\s+)?function\s+([A-Za-z0-9_$]+)/g)) {
		if (COMPONENT_NAME.test(match[1])) names.add(match[1]);
	}
	for (const match of code.matchAll(/\bexport\s+(?:const|let|var)\s+([A-Za-z0-9_$]+)/g)) {
		if (COMPONENT_NAME.test(match[1])) names.add(match[1]);
	}
	// esbuild lowers `export function Foo` to `function Foo(){} … export { Foo };`
	for (const listMatch of code.matchAll(/\bexport\s*\{([^}]*)\}/g)) {
		for (const part of listMatch[1].split(',')) {
			const exported = part
				.trim()
				.split(/\s+as\s+/)
				.at(-1)
				?.trim();
			if (exported !== undefined && exported.length > 0 && COMPONENT_NAME.test(exported)) {
				names.add(exported);
			}
		}
	}
	return [...names];
}

/** Wrap a compiled client module with React Refresh + `import.meta.hot` HMR. */
function wrapForHmr(code: string, importId: string): string {
	const moduleId = developmentClientUrl(importId);
	const runtimeCode = code.replaceAll(/\bimport\.meta\.hot\b/g, '__preview_hot__');
	const components = detectExportedComponents(runtimeCode);
	const registrations = components.map((name) => `  $RefreshReg$(${name}, ${JSON.stringify(name)});`).join('\n');
	return [
		`const __preview_module_id__ = ${JSON.stringify(moduleId)};`,
		`const __preview_runtime__ = window.__PREVIEW_RUNTIME__;`,
		`const __preview_hot__ = __preview_runtime__ ? __preview_runtime__.createHotContext(__preview_module_id__) : undefined;`,
		`if (__preview_runtime__) { __preview_runtime__.registerModule(__preview_module_id__, []); }`,
		`var __prevRefreshReg = window.$RefreshReg$;`,
		`var __prevRefreshSig = window.$RefreshSig$;`,
		`window.$RefreshReg$ = function(type, id) { window.__RefreshRuntime && window.__RefreshRuntime.register(type, __preview_module_id__ + " " + id); };`,
		`window.$RefreshSig$ = window.__RefreshRuntime ? window.__RefreshRuntime.createSignatureFunctionForTransform() : function() { return function(type) { return type; }; };`,
		runtimeCode,
		`if (window.__RefreshRuntime) {\n${registrations}\n}`,
		`window.$RefreshReg$ = __prevRefreshReg;`,
		`window.$RefreshSig$ = __prevRefreshSig;`,
		// A module whose exports are all components is a self-accepting Fast
		// Refresh boundary; otherwise the update bubbles to importers.
		components.length > 0 ? `if (__preview_hot__) { __preview_hot__.accept(); }` : '',
	]
		.filter(Boolean)
		.join('\n');
}

async function serveClientModule(importId: string, context: DevelopmentModuleContext): Promise<DevelopmentModuleResult | undefined> {
	const normalized = normalizePosixPath(importId);
	// Prefer the live (possibly just-edited) source so HMR reflects edits without
	// a full rebuild; fall back to the build snapshot.
	const liveSource = await context.readSource?.(normalized);
	const source = liveSource ?? (context.fileSystem.exists(normalized) ? context.fileSystem.readFileText(normalized) : undefined);
	if (source === undefined) {
		return undefined;
	}
	const transformed = await context.esbuild.transform(source, {
		loader: esbuildLoader(normalized),
		format: 'esm',
		target: 'es2022',
		jsx: 'automatic',
		sourcefile: normalized,
	});
	const rewritten = rewriteImports(transformed.code, normalized, context.fileSystem);
	return { code: wrapForHmr(rewritten, normalized), contentType: 'application/javascript' };
}

const dependencyCache = new Map<string, string>();

/** Identifiers that are never re-exported as named bindings. */
const RESERVED_EXPORTS = new Set(['default', '__esModule']);

/**
 * Detect a CommonJS module's named exports (statically), following a single
 * `module.exports = require('…')` re-export hop (React's entry shape). A pure-JS
 * scanner that mirrors what `cjs-module-lexer` provides for Vite's dependency
 * optimizer, running natively in workerd.
 */
export function detectCjsExports(entryPath: string, fileSystem: MemoryFileSystem): string[] {
	const visited = new Set<string>();
	const names = new Set<string>();
	let current: string | undefined = entryPath;
	while (current !== undefined && !visited.has(current) && fileSystem.exists(current)) {
		visited.add(current);
		const source = fileSystem.readFileText(current);
		for (const match of source.matchAll(/\bexports\.([A-Za-z_$][\w$]*)\s*=/g)) {
			names.add(match[1]);
		}
		for (const match of source.matchAll(/\bObject\.defineProperty\(\s*exports\s*,\s*["']([^"']+)["']/g)) {
			names.add(match[1]);
		}
		// Follow `module.exports = require('./x')` to the real implementation file.
		const reExport = /module\.exports\s*=\s*require\(\s*["']([^"']+)["']\s*\)/.exec(source);
		current = reExport === null ? undefined : resolveProjectModule(current, reExport[1], fileSystem);
	}
	return [...names].filter((name) => !RESERVED_EXPORTS.has(name));
}

/**
 * React family members are not bundled per dev module (that would create a
 * second React instance and break hooks). Instead the bundled client runtime
 * exposes its React on globals (see the bridge's client-entry injection) and
 * these dev modules re-export from those globals, so every dev-served component
 * shares the runtime's single React instance.
 */
export const REACT_FAMILY_GLOBALS = new Map<string, string>([
	['react', '__vinext_react'],
	['react/jsx-runtime', '__vinext_jsx_runtime'],
	['react/jsx-dev-runtime', '__vinext_jsx_dev_runtime'],
	['react-dom', '__vinext_react_dom'],
	['react-dom/client', '__vinext_react_dom_client'],
]);

/** Serve a React-family module as a re-export of the runtime's shared instance. */
function serveReactFamilyGlobal(specifier: string, globalName: string, context: DevelopmentModuleContext): DevelopmentModuleResult {
	const resolved = resolvePackage(specifier, context.fileSystem, conditionsForEnvironment('client'));
	const names = resolved === undefined ? [] : detectCjsExports(resolved.path, context.fileSystem);
	const named = names.length > 0 ? `export const { ${names.join(', ')} } = __shared;\n` : '';
	const code = [
		`const __shared = globalThis.${globalName};`,
		`if (!__shared) { throw new Error("[vinext] ${specifier} is not exposed by the client runtime"); }`,
		`export default __shared;`,
		named,
	].join('\n');
	return { code, contentType: 'application/javascript' };
}

/**
 * Bundle a bare dependency to browser ESM and serve it. React family members
 * are re-exported from the runtime's shared globals (single instance).
 */
async function serveDependency(specifier: string, context: DevelopmentModuleContext): Promise<DevelopmentModuleResult | undefined> {
	const globalName = REACT_FAMILY_GLOBALS.get(specifier);
	if (globalName !== undefined) {
		return serveReactFamilyGlobal(specifier, globalName, context);
	}

	const cached = dependencyCache.get(specifier);
	if (cached !== undefined) {
		return { code: cached, contentType: 'application/javascript' };
	}
	const resolved = resolvePackage(specifier, context.fileSystem, conditionsForEnvironment('client'));
	if (resolved === undefined) {
		// Not in the vendored node_modules (React/RSC only). If it is a registered
		// project dependency, fetch it from esm.sh and bundle it for the browser —
		// mirroring the SSR build bridge (`esbuild-bridge.ts` `routeUnresolvedBare`)
		// so a client component can import a user-added dependency (e.g. `is-even`).
		// Without this, `/@vinext-client-dep/<pkg>` returns nothing, the request
		// falls through to the app route, and the browser gets HTML for a JS module
		// — the client bundle fails to load and the preview shows a blank/crashed page.
		return serveEsmCdnDependency(specifier, context);
	}
	// Re-export proxy (Vite optimizeDeps style): esbuild bundling a CJS entry
	// emits only a `default` export, so `{ Fragment } from "react/jsx-runtime"`
	// fails. Detect the CJS named exports and re-export them explicitly from the
	// default (module.exports), exactly as Vite's cjs-interop does.
	const names = detectCjsExports(resolved.path, context.fileSystem);
	const namedReExport = names.length > 0 ? `export const { ${names.join(', ')} } = __cjs;\n` : '';
	const proxyEntry = `import __cjs from ${JSON.stringify(resolved.path)};\nexport default __cjs;\n${namedReExport}`;
	const result = await context.esbuild.build({
		stdin: { contents: proxyEntry, resolveDir: '/', loader: 'js', sourcefile: 'vinext-dep-proxy.js' },
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		absWorkingDir: '/',
		write: false,
		logLevel: 'silent',
		// Pre-bundle leaf dependencies in production mode (Vite optimizeDeps style):
		// they ship as stable, optimized modules with their CJS env branches
		// resolved at bundle time. (React itself is served separately, sharing the
		// client runtime's single dev instance via globals.)
		define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
		plugins: [createDependencyResolverPlugin(context.fileSystem)],
	});
	const code = result.outputFiles?.[0]?.text ?? '';
	dependencyCache.set(specifier, code);
	return { code, contentType: 'application/javascript' };
}

/** esbuild namespace for browser stubs of `node:` builtins inside a CDN bundle. */
const NODE_STUB_NAMESPACE = 'vinext-dev-node-stub';

/**
 * Serve a registered project dependency that is NOT in the vendored node_modules
 * by fetching it from esm.sh and bundling it to browser ESM — the client-side
 * counterpart of the SSR build's esm.sh fallback. Only packages present in the
 * project's `dependencies` are fetched (unregistered/toolchain specifiers, and
 * the React family, are excluded); returns `undefined` for anything else so the
 * caller can 404 rather than serve a broken module.
 */
async function serveEsmCdnDependency(specifier: string, context: DevelopmentModuleContext): Promise<DevelopmentModuleResult | undefined> {
	const { packageName } = parsePackageSpecifier(specifier);
	if (isEsmCdnExcluded(packageName)) {
		return undefined;
	}
	const version = readDependencyVersions(context.fileSystem).get(packageName);
	if (version === undefined) {
		return undefined;
	}
	const url = buildEsmCdnUrl(specifier, version);
	const result = await context.esbuild.build({
		entryPoints: [url],
		bundle: true,
		format: 'esm',
		platform: 'browser',
		target: 'es2022',
		jsx: 'automatic',
		absWorkingDir: '/',
		write: false,
		logLevel: 'silent',
		define: { 'process.env.NODE_ENV': '"production"', 'process.env': '{}' },
		plugins: [createEsmCdnResolverPlugin()],
	});
	const code = result.outputFiles?.[0]?.text ?? '';
	dependencyCache.set(specifier, code);
	return { code, contentType: 'application/javascript' };
}

/**
 * esbuild plugin that bundles an esm.sh module for the browser dev dependency
 * server. Relative/absolute/http imports inside a fetched module resolve to
 * further esm.sh fetches; bare specifiers (the React family and any peer deps
 * esm.sh externalises via `?external=`) are rewritten to `/@vinext-client-dep/…`
 * and left external, so the browser re-enters the dev server — resolving them to
 * the runtime's single shared React instance (or their own esm.sh fetch).
 */
function createEsmCdnResolverPlugin(): EsbuildPlugin {
	return {
		name: 'vinext-dev-esm-cdn',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (arguments_) => {
				if (arguments_.kind === 'entry-point') {
					return { path: arguments_.path, namespace: ESM_CDN_NAMESPACE };
				}
				if (arguments_.namespace !== ESM_CDN_NAMESPACE) {
					return;
				}
				// Browser can't load node: builtins; stub to an empty module (vinext's
				// client shims guard these, mirroring the SSR bridge's client stub).
				if (arguments_.path.startsWith('node:')) {
					return { path: arguments_.path, namespace: NODE_STUB_NAMESPACE };
				}
				if (arguments_.path.startsWith('.') || arguments_.path.startsWith('/') || arguments_.path.startsWith('http')) {
					return { path: resolveEsmCdnImport(arguments_.importer, arguments_.path), namespace: ESM_CDN_NAMESPACE };
				}
				// Bare specifier externalised by esm.sh — hand back to the browser dev
				// dependency server (single React instance / transitive esm.sh fetch).
				return { path: DEPENDENCY_PREFIX + encodeURIComponent(arguments_.path), external: true };
			});
			build.onLoad({ filter: /.*/, namespace: ESM_CDN_NAMESPACE }, async (arguments_) => {
				const source = await fetchEsmModule(arguments_.path);
				return { contents: source, loader: 'js' };
			});
			build.onLoad({ filter: /.*/, namespace: NODE_STUB_NAMESPACE }, () => ({ contents: 'module.exports = {};', loader: 'js' }));
		},
	};
}

/** esbuild plugin resolving a dependency bundle against the in-memory node_modules. */
function createDependencyResolverPlugin(fileSystem: MemoryFileSystem): EsbuildPlugin {
	const namespace = 'vinext-dev-dep';
	return {
		name: 'vinext-dev-dep-resolver',
		setup(build) {
			build.onResolve({ filter: /.*/ }, (arguments_) => {
				if (arguments_.kind === 'entry-point') {
					return { path: arguments_.path, namespace };
				}
				if (arguments_.path.startsWith('node:')) {
					return { path: arguments_.path, external: true };
				}
				// Bundle each dependency self-contained (Vite optimizeDeps style) so
				// its named exports are intact (e.g. react/jsx-runtime's `Fragment`,
				// derived from React at runtime). `react` is loaded once by URL, so
				// the bundled react-dom and the unbundled components share its hooks
				// dispatcher; jsx/Fragment interoperate across copies via `Symbol.for`.
				if (isBareSpecifier(arguments_.path)) {
					const resolved = resolvePackage(arguments_.path, fileSystem, conditionsForEnvironment('client'));
					return resolved === undefined ? { path: arguments_.path, external: true } : { path: resolved.path, namespace };
				}
				const base = arguments_.path.startsWith('/') ? arguments_.path : `${directoryOf(arguments_.importer)}/${arguments_.path}`;
				const resolved = resolveProjectModule('/', base, fileSystem) ?? normalizePosixPath(base);
				return { path: resolved, namespace };
			});
			build.onLoad({ filter: /.*/, namespace }, (arguments_) => {
				if (!fileSystem.exists(arguments_.path)) {
					return { errors: [{ text: `dev dependency module not found: ${arguments_.path}` }] };
				}
				return {
					contents: fileSystem.readFileText(arguments_.path),
					loader: esbuildLoader(arguments_.path),
					resolveDir: directoryOf(arguments_.path),
				};
			});
		},
	};
}
