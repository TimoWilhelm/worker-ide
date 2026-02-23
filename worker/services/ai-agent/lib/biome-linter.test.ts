/**
 * Tests for the Biome linter RPC client and formatting helpers.
 *
 * Runs in the workerd pool. The BIOME service binding is not wired up in the
 * test environment, so RPC calls hit the try/catch and return empty results —
 * which is exactly what we want to verify for the graceful-fallback path.
 *
 * The core Biome WASM logic is tested in auxiliary/biome/biome-worker.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { formatLintDiagnostics, formatLintResultsForAgent } from './biome-linter';

import type { ServerLintDiagnostic } from '@shared/biome-types';

// =============================================================================
// formatLintDiagnostics
// =============================================================================

describe('formatLintDiagnostics', () => {
	it('returns undefined for empty diagnostics array', () => {
		expect(formatLintDiagnostics([])).toBeUndefined();
	});

	it('formats a single error diagnostic with auto-fixable tag', () => {
		const diagnostics: ServerLintDiagnostic[] = [
			{ line: 2, rule: 'lint/suspicious/noDoubleEquals', message: 'Using == may be unsafe.', severity: 'error', fixable: true },
		];

		const formatted = formatLintDiagnostics(diagnostics);
		expect(formatted).toBeDefined();
		expect(formatted).toContain('line 2');
		expect(formatted).toContain('noDoubleEquals');
		expect(formatted).toContain('[auto-fixable]');
		expect(formatted).toContain('1 error(s)');
	});

	it('formats mixed severity diagnostics with correct counts', () => {
		const diagnostics: ServerLintDiagnostic[] = [
			{ line: 1, rule: 'lint/suspicious/noDebugger', message: 'Unexpected debugger', severity: 'error', fixable: false },
			{ line: 3, rule: 'lint/correctness/noUnusedVariables', message: 'Unused variable', severity: 'warning', fixable: true },
		];

		const formatted = formatLintDiagnostics(diagnostics);
		expect(formatted).toBeDefined();
		expect(formatted).toContain('1 error(s)');
		expect(formatted).toContain('1 warning(s)');
	});

	it('includes auto-fixable tag only for fixable diagnostics', () => {
		const diagnostics: ServerLintDiagnostic[] = [
			{ line: 1, rule: 'a', message: 'fixable issue', severity: 'warning', fixable: true },
			{ line: 2, rule: 'b', message: 'unfixable issue', severity: 'warning', fixable: false },
		];

		const formatted = formatLintDiagnostics(diagnostics)!;
		const lines = formatted.split('\n');

		const fixableLine = lines.find((line) => line.includes('fixable issue'));
		expect(fixableLine).toContain('[auto-fixable]');

		const unfixableLine = lines.find((line) => line.includes('unfixable issue'));
		expect(unfixableLine).not.toContain('[auto-fixable]');
	});
});

// =============================================================================
// formatLintResultsForAgent
// =============================================================================

describe('formatLintResultsForAgent', () => {
	it('returns undefined for unsupported file types', async () => {
		const result = await formatLintResultsForAgent('/readme.md', '# Hello');
		expect(result).toBeUndefined();
	});

	it('returns undefined when BIOME service is unavailable', async () => {
		// The BIOME service binding is not wired up in the test workerd environment,
		// so the RPC call throws and the catch block returns []. This verifies the
		// graceful fallback path.
		const result = await formatLintResultsForAgent('/clean.ts', 'const x = 1;');
		expect(result).toBeUndefined();
	});
});
