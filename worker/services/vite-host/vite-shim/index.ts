/**
 * `vite` module shim.
 *
 * Aliased to the bare specifier `vite` when esbuild bundles the native plugins
 * (vinext, `@vitejs/plugin-rsc`) for execution in a `LOADER` isolate. The real
 * Vite package is a Node/Rolldown application that cannot run in workerd; the
 * spike (Phase 0) confirmed the plugins import only a small set of pure-ish
 * utilities from `vite`, which this module reimplements.
 *
 * - Pure functions (`normalizePath`, `isCSSRequest`, `defineConfig`, …) are
 *   implemented inline.
 * - `parseAst` / `parseAstAsync` use acorn (+ JSX) to produce an ESTree program,
 *   matching the AST shape the plugins walk.
 * - `transformWithOxc` / `loadEnv` delegate to host services (see `./services`).
 */
import { Parser } from 'acorn';
import jsx from 'acorn-jsx';
import { tsPlugin } from 'acorn-typescript';

import { getViteHostServices } from './services';
import { globToRegExp } from '../node-fs/glob';

import type { ViteTransformResult } from './services';
import type { Options as AcornOptions, Program } from 'acorn';

const JsxParser = Parser.extend(jsx());

// Parses TypeScript + JSX directly (no prior transform), so node `start`/`end`
// offsets stay aligned with the original source — which plugins that edit code
// via MagicString (e.g. plugin-rsc's RSC/CSS export wrapping) depend on.
// acorn-typescript's plugin is runtime-compatible with acorn's `Parser.extend`
// but its published type doesn't line up with acorn's plugin signature.
// @ts-expect-error -- acorn-typescript plugin type diverges from acorn's `extend` parameter type
const TsxParser = Parser.extend(tsPlugin({ jsx: {} }));

const DEFAULT_ACORN_OPTIONS: AcornOptions = {
	ecmaVersion: 'latest',
	sourceType: 'module',
	allowAwaitOutsideFunction: true,
	allowReturnOutsideFunction: true,
	allowSuperOutsideMethod: true,
	locations: false,
	ranges: false,
};

/**
 * Parse JS/JSX source into an ESTree `Program`. Acorn nodes carry `start`/`end`
 * offsets, matching what `estree-walker`-based plugin code expects.
 *
 * Note: acorn does not understand TypeScript type syntax. Callers handling
 * `.ts`/`.tsx` should transform to JS first (see `parseAstAsync`, which does so
 * via the host transform service).
 */
export function parseAst(code: string, options?: AcornOptions): Program {
	return JsxParser.parse(code, { ...DEFAULT_ACORN_OPTIONS, ...options });
}

/**
 * Synchronous parse returning an oxc-style `{ program }` wrapper. Used by
 * vinext's build-time reporting on already-transformed JS; throws on TS/JSX it
 * cannot parse synchronously.
 */
export function parseSync(code: string, options?: AcornOptions): { program: Program } {
	return { program: parseAst(code, options) };
}

/**
 * Async parse. Plain JS/JSX is parsed with acorn-jsx; TypeScript (which acorn
 * rejects) is parsed with the acorn-typescript extension. Crucially this parses
 * the TS/TSX *as-is* rather than transforming it first, so the returned node
 * offsets match the input string and callers can drive `MagicString` edits
 * against the same source (what `@vitejs/plugin-rsc` does for client-reference
 * and CSS export wrapping).
 */
export async function parseAstAsync(code: string, options?: AcornOptions): Promise<Program> {
	try {
		return parseAst(code, options);
	} catch {
		return parseTsx(code, options);
	}
}

/** Parse TypeScript/TSX into an ESTree `Program` with source-aligned offsets. */
function parseTsx(code: string, options?: AcornOptions): Program {
	// acorn-typescript requires `locations`; node `start`/`end` offsets are still
	// produced and remain aligned with the input source.
	return TsxParser.parse(code, { ...DEFAULT_ACORN_OPTIONS, ...options, locations: true });
}

/** Strip types / compile JSX. Delegates to the host esbuild service. */
export async function transformWithOxc(code: string, id: string, options?: { sourcemap?: boolean }): Promise<ViteTransformResult> {
	const services = getViteHostServices();
	if (services === undefined) {
		throw new Error('transformWithOxc requires host services to be installed');
	}
	return services.transform(code, id, options);
}

/** Vite alias retained by some plugins; identical contract to transformWithOxc. */
export const transformWithEsbuild = transformWithOxc;

/** Load `.env*` values for a mode. Delegates to the host filesystem service. */
// `loadEnv` must keep its Vite API name; the abbreviation is part of the contract.
// eslint-disable-next-line unicorn/prevent-abbreviations
export function loadEnv(mode: string, _environmentDirectory: string, prefixes?: string | string[]): Record<string, string> {
	const services = getViteHostServices();
	if (services === undefined) {
		return {};
	}
	const normalizedPrefixes = prefixes === undefined ? ['VITE_'] : Array.isArray(prefixes) ? prefixes : [prefixes];
	return services.loadEnv(mode, normalizedPrefixes);
}

export interface PreprocessCssResult {
	code: string;
	map?: string;
	deps?: string[];
}

/**
 * Preprocess CSS. Plain CSS passes through unchanged. Preprocessor dialects
 * (Sass/Less/Stylus) are not yet compiled in the host; callers relying on them
 * will receive the source verbatim until a workerd-compatible compiler is wired
 * in. This mirrors Vite's `preprocessCSS` signature.
 */
export async function preprocessCSS(code: string, _filename: string): Promise<PreprocessCssResult> {
	return { code, deps: [] };
}

/** Convert Windows-style separators to POSIX. */
export function normalizePath(id: string): string {
	return id.replaceAll('\\', '/');
}

/** Identity helper Vite exposes so configs get type inference. */
export function defineConfig<ConfigType>(config: ConfigType): ConfigType {
	return config;
}

const CSS_LANGS = /\.(css|less|sass|scss|styl|stylus|pcss|postcss|sss)(?:$|\?)/;

/** Whether a module id refers to a stylesheet (matches Vite's `isCSSRequest`). */
export function isCSSRequest(request: string): boolean {
	return CSS_LANGS.test(request);
}

/**
 * In real Vite this enforces the dev server's fs allow-list. Inside the host
 * every module already comes from the project Workspace, so loading is always
 * permitted.
 */
export function isFileLoadingAllowed(): boolean {
	return true;
}

/** Export conditions used when resolving server modules. */
export const defaultServerConditions: readonly string[] = ['workerd', 'module', 'node'];

/**
 * Reported Vite version. The native plugins gate feature flags on the major
 * version; we report 8 so they take modern code paths (native tsconfig paths,
 * Rolldown-style options) consistent with the version vinext targets.
 */
export const version = '8.0.0';

export type FilterPattern = string | RegExp | Array<string | RegExp> | undefined;

function toMatchers(pattern: FilterPattern): Array<(id: string) => boolean> {
	if (pattern === undefined) {
		return [];
	}
	const patterns = Array.isArray(pattern) ? pattern : [pattern];
	return patterns.map((entry) => {
		if (entry instanceof RegExp) {
			return (id: string) => entry.test(id);
		}
		const regex = globToRegExp(entry);
		return (id: string) => regex.test(id);
	});
}

/**
 * Build an include/exclude id filter, matching Vite's `createFilter`
 * (re-exported from `@rollup/pluginutils`). An id passes when it matches an
 * include pattern (or there are none) and matches no exclude pattern.
 */
export function createFilter(include?: FilterPattern, exclude?: FilterPattern): (id: string) => boolean {
	const includeMatchers = toMatchers(include);
	const excludeMatchers = toMatchers(exclude);
	return (id: string) => {
		if (excludeMatchers.some((matches) => matches(id))) {
			return false;
		}
		return includeMatchers.length === 0 || includeMatchers.some((matches) => matches(id));
	};
}

export default {
	parseAst,
	parseAstAsync,
	parseSync,
	transformWithOxc,
	transformWithEsbuild,
	preprocessCSS,
	loadEnv,
	normalizePath,
	defineConfig,
	isCSSRequest,
	isFileLoadingAllowed,
	defaultServerConditions,
	createFilter,
	version,
};
