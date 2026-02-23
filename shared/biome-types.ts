/**
 * Shared types for Biome linting and formatting.
 *
 * Used by both the Biome auxiliary worker (auxiliary/biome/) and the main
 * worker's thin RPC client (worker/services/ai-agent/lib/biome-linter.ts).
 */

// =============================================================================
// Lint Diagnostics
// =============================================================================

export interface ServerLintDiagnostic {
	/** 1-based line number */
	line: number;
	/** Rule category (e.g. "lint/style/noVar") */
	rule: string;
	/** Human-readable message */
	message: string;
	/** Severity */
	severity: 'error' | 'warning';
	/** Whether Biome can auto-fix this diagnostic */
	fixable: boolean;
}

// =============================================================================
// Fix Results
// =============================================================================

/**
 * Result of an autofix operation.
 */
export interface ServerLintFixResult {
	/** The fixed file content */
	fixedContent: string;
	/** Number of fixes applied */
	fixCount: number;
	/** Remaining diagnostics after fix */
	remainingDiagnostics: ServerLintDiagnostic[];
}

/**
 * Returned when fixFileForAgent cannot apply fixes.
 * The `reason` field contains a human-readable explanation of why.
 */
export interface FixFileFailure {
	failed: true;
	reason: string;
}
