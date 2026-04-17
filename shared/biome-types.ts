export interface ServerLintDiagnostic {
	line: number;
	column: number;
	rule: string;
	message: string;
	severity: 'error' | 'warning';
	fixable: boolean;
}
export interface ServerLintFixResult {
	fixedContent: string;
	fixCount: number;
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
