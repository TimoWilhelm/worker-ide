/**
 * Biome Auxiliary Worker
 *
 * Runs the Biome WASM binary (~22 MiB) in a dedicated Cloudflare Worker,
 * separate from the main worker to stay under the 10 MiB compressed size
 * limit per worker. The main worker calls this via a service binding (RPC).
 *
 * Exports a WorkerEntrypoint with two RPC methods:
 * - lintFile(filePath, content)  — returns lint diagnostics
 * - fixFile(filePath, content)   — applies autofixes and returns result
 *
 * Core logic lives in `biome-core.ts` (no Cloudflare-specific imports) so
 * it can be tested directly without mocking `cloudflare:workers`.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

import { fixFile, lintFile } from './biome-core';

import type { FixFileFailure, ServerLintDiagnostic, ServerLintFixResult } from '@shared/biome-types';

// Re-export standalone functions for direct use in tests
export { fixFile, lintFile } from './biome-core';

// =============================================================================
// WorkerEntrypoint — RPC methods called by the main worker via service binding
// =============================================================================

export default class BiomeWorker extends WorkerEntrypoint {
	async lintFile(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
		return lintFile(filePath, content);
	}

	async fixFile(filePath: string, content: string): Promise<ServerLintFixResult | FixFileFailure> {
		return fixFile(filePath, content);
	}
}
