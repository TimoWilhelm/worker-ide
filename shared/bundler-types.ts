/**
 * Shared types for the bundler auxiliary worker.
 *
 * Defines the generic bundler interface contract used by both the auxiliary
 * esbuild-worker (auxiliary/esbuild/) and the main worker's thin RPC client
 * (worker/services/bundler-client.ts).
 *
 * These types are intentionally bundler-agnostic — a future SWC or Rolldown
 * worker can implement the same interface by matching these shapes.
 */

import type { DependencyError } from './types';

// =============================================================================
// Transform
// =============================================================================

export interface TransformOptions {
	sourcemap?: boolean;
	tsconfigRaw?: string;
}

export interface TransformResult {
	code: string;
	map?: string;
}

// =============================================================================
// Bundle
// =============================================================================

export interface BundleWithCdnOptions {
	/** Virtual filesystem — file paths mapped to their string content. */
	files: Record<string, string>;
	/** Entry point path (relative, matching a key in `files`). */
	entryPoint: string;
	/** Bare specifiers to mark as external (not resolved via CDN). */
	externals?: string[];
	/** Minify the output. */
	minify?: boolean;
	/** Emit inline source maps. */
	sourcemap?: boolean;
	/** Raw tsconfig JSON string for esbuild's `tsconfigRaw` option. */
	tsconfigRaw?: string;
	/** Target platform for the bundle. */
	platform?: 'browser' | 'neutral';
	/** Known registered dependencies (name to version). Only these are resolved from CDN. */
	knownDependencies?: Map<string, string>;
	/** When true, inject React Fast Refresh registration wrappers into user modules. */
	reactRefresh?: boolean;
}

export interface BundleResult {
	code: string;
	map?: string;
	warnings?: string[];
	/** Structured dependency errors collected during bundling. */
	dependencyErrors?: DependencyError[];
}

// =============================================================================
// Error
// =============================================================================

/**
 * Error class that carries structured dependency errors alongside the original
 * build error. Used by callers to extract `dependencyErrors` from failed builds.
 *
 * When bundling crosses an RPC boundary, the client reconstructs this class
 * from the serialized error cause so that `instanceof` checks continue to work.
 */
export class BundleDependencyError extends Error {
	readonly dependencyErrors: DependencyError[];
	constructor(originalError: unknown, dependencyErrors: DependencyError[]) {
		super(originalError instanceof Error ? originalError.message : String(originalError));
		this.name = 'BundleDependencyError';
		this.dependencyErrors = dependencyErrors;
	}
}
