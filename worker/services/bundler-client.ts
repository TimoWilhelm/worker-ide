/**
 * Bundler Client — RPC Client
 *
 * Thin wrapper that delegates transform and bundle operations to the esbuild
 * auxiliary worker via a service binding (RPC). The heavy WASM binary lives
 * in the auxiliary worker; this module only handles request forwarding.
 *
 * Exposes the same function signatures as the former bundler-service.ts so
 * that callers only need to update their import paths.
 *
 * The interface is generic — if the underlying bundler worker is swapped
 * (e.g. to SWC or Rolldown), callers of this module remain unchanged.
 */

import { env } from 'cloudflare:workers';

import { BundleDependencyError } from '@shared/bundler-types';

import type { BundleResult, BundleWithCdnOptions, TransformOptions, TransformResult } from '@shared/bundler-types';
import type { DependencyError } from '@shared/types';

// Re-export shared types so consumers can import from this module
export { BundleDependencyError } from '@shared/bundler-types';
export type { BundleResult, BundleWithCdnOptions, TransformOptions, TransformResult } from '@shared/bundler-types';

// =============================================================================
// Public API — delegates to esbuild auxiliary worker via service binding
// =============================================================================

/**
 * Transform TypeScript/JSX code to JavaScript.
 * Delegates to the esbuild auxiliary worker via RPC.
 */
export async function transformCode(code: string, filename: string, options?: TransformOptions): Promise<TransformResult> {
	return env.ESBUILD.transformCode(code, filename, options);
}

/**
 * Bundle files into a single JavaScript module, resolving bare package imports
 * from esm.sh CDN at bundle time.
 * Delegates to the esbuild auxiliary worker via RPC.
 *
 * Workers RPC serializes errors via structured clone, which strips the
 * prototype chain — custom error subclasses arrive as plain `Error` on the
 * caller side. We reconstruct `BundleDependencyError` from the serialized
 * error's `name` and `dependencyErrors` properties so that `instanceof`
 * checks in callers (preview-service.ts) continue to work.
 */
export async function bundleWithCdn(options: BundleWithCdnOptions): Promise<BundleResult> {
	try {
		return await env.ESBUILD.bundleWithCdn(options);
	} catch (error) {
		throw reconstructBundleDependencyError(error) ?? error;
	}
}

// =============================================================================
// Error Reconstruction
// =============================================================================

/**
 * Attempt to reconstruct a `BundleDependencyError` from a serialized RPC error.
 *
 * Workers RPC preserves `error.name` and structurally-cloneable custom
 * properties (like `dependencyErrors: DependencyError[]`), but the
 * `instanceof` chain is lost. This function checks for the characteristic
 * shape and re-wraps it so callers can use `instanceof BundleDependencyError`.
 *
 * Returns `undefined` if the error is not a serialized `BundleDependencyError`.
 */
function reconstructBundleDependencyError(error: unknown): BundleDependencyError | undefined {
	if (!(error instanceof Error)) return undefined;

	// Check for the characteristic shape: name or dependencyErrors property.
	// Workers RPC preserves custom enumerable properties on errors, so
	// `dependencyErrors` survives serialization even though the prototype is lost.
	const hasDependencyErrors = 'dependencyErrors' in error && Array.isArray(error.dependencyErrors) && error.dependencyErrors.length > 0;
	const hasMatchingName = error.name === 'BundleDependencyError';

	if (!hasDependencyErrors && !hasMatchingName) return undefined;

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- RPC-serialized property validated via Array.isArray above
	const dependencyErrors: DependencyError[] = hasDependencyErrors ? (error.dependencyErrors as DependencyError[]) : [];
	return new BundleDependencyError(error, dependencyErrors);
}
