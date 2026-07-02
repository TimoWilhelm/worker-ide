/**
 * Build the esbuild `define` map from the resolved Vite config.
 *
 * Vite/vinext `define` values are replacement *expressions* (already-quoted
 * strings, etc.), matching esbuild's contract. We coerce any non-string values
 * to JSON and guarantee `process.env.NODE_ENV` so React's CommonJS entry
 * wrappers dead-code-eliminate their development branches.
 */
import type { ResolvedConfig } from './types';

export interface DefineOptions {
	/**
	 * Build the browser bundle as a development client for the preview: sets
	 * `NODE_ENV`/`import.meta.env.DEV` to development (so React DOM ships its Fast
	 * Refresh renderer helpers and vinext's client dev runtime is active) and
	 * defines `import.meta.hot` to a host hot context. Enables module-level React
	 * Fast Refresh for client components. Only for the `client` environment in
	 * host development mode; server/deploy builds stay production.
	 */
	clientHmr?: boolean;
}

export function toEsbuildDefine(config: ResolvedConfig, options: DefineOptions = {}): Record<string, string> {
	// Key production off `mode`, NOT `command`: the vinext host always builds with
	// `command: 'build'` and overloads `mode` to select the build (`development`
	// for preview, `production` for deploy). Using `command` here would force the
	// preview SERVER bundle to NODE_ENV=production while the shared React modules
	// are built development (see vinext-build serverDefine) — a __DEV__ mismatch
	// that crashes the dev RSC render with `dispatcher.getOwner is not a function`
	// (production react-server-dom-webpack sets an owner dispatcher the dev React
	// createElement calls `getOwner()` on).
	const isProduction = config.mode === 'production';
	// The client HMR build must use development React so React DOM exposes its
	// Fast Refresh renderer helpers; everything else stays production.
	const nodeEnvironment = options.clientHmr ? 'development' : isProduction ? 'production' : 'development';
	const importMetaEnvironment = {
		// The preview client runs as a development build so React Fast Refresh and
		// vinext's client dev runtime are active (`__vite_rsc_build__` stays true so
		// client references still resolve through the built manifest).
		DEV: options.clientHmr ? true : !isProduction,
		PROD: isProduction,
		MODE: config.mode,
		SSR: true,
		BASE_URL: config.base,
		// plugin-rsc's SSR/runtime branch on this to pick built module maps over
		// dev (`@id/`) module ids.
		__vite_rsc_build__: config.command === 'build',
	};
	const define: Record<string, string> = {
		'process.env.NODE_ENV': JSON.stringify(nodeEnvironment),
		// Vite's `import.meta.env` — vinext/plugin-rsc read `.DEV`/`.PROD`/`.SSR`.
		'import.meta.env': JSON.stringify(importMetaEnvironment),
	};
	if (options.clientHmr) {
		// `import.meta.hot` resolves to a host hot context installed before any
		// module runs (by the injected preview glue), connecting vinext's client
		// HMR listeners to the preview runtime's event bus.
		define['import.meta.hot'] = 'globalThis.__vinext_client_hot__';
	}
	for (const [key, value] of Object.entries(config.define)) {
		define[key] = typeof value === 'string' ? value : JSON.stringify(value);
	}
	return define;
}
