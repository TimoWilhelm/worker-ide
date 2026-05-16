export interface ServerLintDiagnostic {
	line: number;
	column: number;
	from: number;
	to: number;
	rule: string;
	message: string;
	severity: 'error' | 'warning';
	fixable: boolean;
}
export interface ServerFixResult {
	fixedContent: string;
	/** Number of lint diagnostics resolved by auto-fix (does not count formatting changes). */
	fixCount: number;
	remainingDiagnostics: ServerLintDiagnostic[];
}

/**
 * Returned when fixFile cannot apply formatting/fixes.
 * The `reason` field contains a human-readable explanation of why.
 */
export interface FixFileFailure {
	failed: true;
	reason: string;
}
