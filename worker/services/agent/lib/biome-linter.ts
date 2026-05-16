import { env } from 'cloudflare:workers';

import type { FixFileFailure, ServerLintDiagnostic, ServerFixResult } from '@shared/biome-types';

// Re-export shared types so consumers can import from this module
export type { FixFileFailure, ServerLintDiagnostic, ServerFixResult } from '@shared/biome-types';

const LINTABLE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.css', '.json']);

function isLintableFile(filePath: string): boolean {
	const extension = filePath.slice(filePath.lastIndexOf('.'));
	return LINTABLE_EXTENSIONS.has(extension);
}

/**
 * Lint a file and return diagnostics.
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
 * Format a file and apply safe lint fixes using the Biome auxiliary worker.
 * Returns the fixed content and remaining diagnostics, or a failure object
 * with a human-readable reason when the operation cannot be performed.
 */
export async function fixFileForAgent(filePath: string, content: string): Promise<ServerFixResult | FixFileFailure> {
	if (!isLintableFile(filePath)) {
		return { failed: true, reason: `File type not supported for fixing: ${filePath}` };
	}

	try {
		return await env.BIOME.fixFile(filePath, content);
	} catch (error) {
		return { failed: true, reason: `Biome service error: ${error instanceof Error ? error.message : String(error)}` };
	}
}

export async function applySingleFixForAgent(filePath: string, content: string, from: number, to: number): Promise<string | undefined> {
	if (!isLintableFile(filePath)) return undefined;

	try {
		return await env.BIOME.applySingleFix(filePath, content, from, to);
	} catch (error) {
		console.warn('[biome-linter] applySingleFix RPC failed:', error);
		return undefined;
	}
}

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
