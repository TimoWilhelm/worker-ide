/**
 * `node:module` shim for the Vite Surface Host runtime.
 *
 * vinext resolves its optional peer plugins with
 * `createRequire(...).resolve(specifier)` and then dynamically imports the
 * resolved path. In workerd there is no real module resolver, and the peer
 * plugins are instead bundled in (their dynamic imports are rewritten to literal
 * specifiers during vendoring). This shim makes `.resolve()` acknowledge the
 * bundled peers — returning the bare specifier so vinext's "is it installed?"
 * guards pass — and report everything else as absent so optional integrations
 * (MDX, tsconfig-paths, …) degrade gracefully instead of crashing.
 */
const BUNDLED_PEERS = new Set(['@vitejs/plugin-react', '@vitejs/plugin-rsc', '@vitejs/plugin-rsc/transforms']);

/** Runtime package prefixes provided to the server isolate (left external at build). */
const RUNTIME_PREFIXES = ['@vitejs/plugin-rsc/', 'react-server-dom-webpack/'];

function isResolvableRuntime(specifier: string): boolean {
	return BUNDLED_PEERS.has(specifier) || RUNTIME_PREFIXES.some((prefix) => specifier.startsWith(prefix));
}

interface RequireLike {
	(specifier: string): unknown;
	resolve(specifier: string): string;
}

/**
 * Synthetic `require()` results. vinext reads `vite/package.json` to detect the
 * Vite major version; we report Vite 8 so it takes the modern code paths and
 * skips the `vite-tsconfig-paths` peer requirement (Vite 8 resolves tsconfig
 * path aliases natively). vinext's Vite 8 build options are advisory — the host
 * drives esbuild directly — so the reported version only gates feature flags.
 */
const VIRTUAL_REQUIRE: Record<string, unknown> = {
	'vite/package.json': { name: 'vite', version: '8.0.0' },
};

function hostRequire(specifier: string): unknown {
	if (specifier in VIRTUAL_REQUIRE) {
		return VIRTUAL_REQUIRE[specifier];
	}
	throw new Error(`require("${specifier}") is not supported in the Vite Surface Host runtime`);
}

function resolveSpecifier(specifier: string): string {
	if (isResolvableRuntime(specifier)) {
		return specifier;
	}
	const error = new Error(`Cannot find module '${specifier}'`);
	Object.assign(error, { code: 'MODULE_NOT_FOUND' });
	throw error;
}

export function createRequire(_from: string | URL): RequireLike {
	return Object.assign(hostRequire, { resolve: resolveSpecifier });
}

/**
 * Minimal `Module` stub. vinext's CommonJS config loader references it to
 * compile `.cjs`/CJS `next.config` files. App Router projects use ESM config or
 * none, so this path is not exercised; instantiation throws to flag it loudly.
 */
export class Module {
	paths: string[] = [];
	exports: Record<string, unknown> = {};

	constructor(_id?: string, _parent?: unknown) {
		throw new Error('CommonJS module loading is not supported in the Vite Surface Host runtime');
	}

	static _nodeModulePaths(_from: string): string[] {
		return [];
	}

	static createRequire = createRequire;
}

export const builtinModules: string[] = [];

export function isBuiltin(specifier: string): boolean {
	return specifier.startsWith('node:');
}

export default { createRequire, Module, builtinModules, isBuiltin };
