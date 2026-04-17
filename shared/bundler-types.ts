import type { DependencyError } from './types';

export interface TransformOptions {
	sourcemap?: boolean;
	tsconfigRaw?: string;
}

export interface TransformResult {
	code: string;
	map?: string;
}

export interface BundleWithCdnOptions {
	files: Record<string, string>;
	entryPoint: string;
	externals?: string[];
	minify?: boolean;
	sourcemap?: boolean;
	tsconfigRaw?: string;
	platform?: 'browser' | 'neutral';
	knownDependencies?: Map<string, string>;
	reactRefresh?: boolean;
}

export interface BundleResult {
	code: string;
	map?: string;
	warnings?: string[];
	dependencyErrors?: DependencyError[];
}

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
