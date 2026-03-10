/**
 * Esbuild Auxiliary Worker
 *
 * Runs the esbuild WASM binary in a dedicated Cloudflare Worker, separate
 * from the main worker to avoid inflating the main bundle size. The main
 * worker calls this via a service binding (RPC).
 *
 * Exports a WorkerEntrypoint with two RPC methods:
 * - transformCode(code, filename, options?)  — single-file TS/JSX → JS transform
 * - bundleWithCdn(options)                   — multi-file bundle with CDN resolution
 *
 * Core logic lives in `esbuild-core.ts` (no Cloudflare-specific imports) so
 * it can be tested directly without mocking `cloudflare:workers`.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

import { bundleWithCdn, transformCode } from './esbuild-core';

import type { BundleResult, BundleWithCdnOptions, TransformOptions, TransformResult } from '@shared/bundler-types';

// Re-export standalone functions for direct use in tests
export { bundleWithCdn, transformCode } from './esbuild-core';

// =============================================================================
// WorkerEntrypoint — RPC methods called by the main worker via service binding
// =============================================================================

export default class EsbuildWorker extends WorkerEntrypoint {
	async transformCode(code: string, filename: string, options?: TransformOptions): Promise<TransformResult> {
		return transformCode(code, filename, options);
	}

	async bundleWithCdn(options: BundleWithCdnOptions): Promise<BundleResult> {
		return bundleWithCdn(options);
	}
}
