/**
 * Server-side Biome Linter — RPC Client
 *
 * Thin wrapper that delegates lint and fix operations to the Biome auxiliary
 * worker via a service binding (RPC). The heavy WASM binary lives in the
 * auxiliary worker; this module only handles request forwarding and result
 * formatting.
 *
 * If the service binding call fails for any reason, lint calls silently
 * return empty results so they never block file operations.
 */

import { env } from 'cloudflare:workers';

import type { FixFileFailure, ServerLintDiagnostic, ServerLintFixResult } from '@shared/biome-types';

// Re-export shared types so consumers can import from this module
export type { FixFileFailure, ServerLintDiagnostic, ServerLintFixResult } from '@shared/biome-types';

// =============================================================================
// Supported Extensions
// =============================================================================

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

// =============================================================================
// Public API — delegates to Biome auxiliary worker via service binding
// =============================================================================

/**
 * Lint a file and return diagnostics formatted for AI agent consumption.
 * Returns an empty array if the file type is unsupported or the Biome worker is unavailable.
 */
export async function lintFileForAgent(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
	if (!isLintableFile(filePath)) return [];

	try {
		return await env.BIOME.lintFile(filePath, content);
	} catch {
		return [];
	}
}

/**
 * Apply safe lint fixes to a file using the Biome auxiliary worker.
 * Returns the fixed content and remaining diagnostics, or a failure object
 * with a human-readable reason when fixes cannot be applied.
 */
export async function fixFileForAgent(filePath: string, content: string): Promise<ServerLintFixResult | FixFileFailure> {
	if (!isLintableFile(filePath)) {
		return { failed: true, reason: `File type not supported for lint fixing: ${filePath}` };
	}

	try {
		return await env.BIOME.fixFile(filePath, content);
	} catch (error) {
		return { failed: true, reason: `Biome service error: ${error instanceof Error ? error.message : String(error)}` };
	}
}

// =============================================================================
// Formatting Helpers — pure functions, no WASM or RPC needed
// =============================================================================

/**
 * Format pre-computed lint diagnostics as a string suitable for appending to tool results.
 * Returns undefined if the array is empty.
 *
 * Each diagnostic is formatted as:
 *   Error [19:1] 'VersionBadge' is declared but its value is never read. [auto-fixable]
 */
export function formatLintDiagnostics(diagnostics: ServerLintDiagnostic[]): string | undefined {
	if (diagnostics.length === 0) return undefined;

	const severityLabel = (severity: ServerLintDiagnostic['severity']): string => (severity === 'error' ? 'Error' : 'Warning');

	const lines = diagnostics.map(
		(diagnostic) =>
			`${severityLabel(diagnostic.severity)} [${diagnostic.line}:${diagnostic.column}] ${diagnostic.message}${diagnostic.fixable ? ' [auto-fixable]' : ''}`,
	);

	const errorCount = diagnostics.filter((diagnostic) => diagnostic.severity === 'error').length;
	const warningCount = diagnostics.length - errorCount;

	const summary = [errorCount > 0 ? `${errorCount} error(s)` : '', warningCount > 0 ? `${warningCount} warning(s)` : '']
		.filter(Boolean)
		.join(', ');

	return `Lint diagnostics (${summary}):\n${lines.join('\n')}`;
}
