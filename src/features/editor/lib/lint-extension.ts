/**
 * CodeMirror Biome Lint Extension
 *
 * Creates a CodeMirror linter extension that runs Biome WASM on the
 * editor content and returns diagnostics as inline squiggly underlines.
 * Each fixable diagnostic gets a "Fix" action in its tooltip (VSCode-style).
 *
 * Keyboard shortcuts:
 * - Ctrl+. / Cmd+. — Quick Fix: apply safe fix for the diagnostic at cursor
 * - Ctrl+Shift+. / Cmd+Shift+. — Fix All: apply all safe fixes in the file
 *
 * Also dispatches a CustomEvent so the Output panel can display them.
 */

import { forEachDiagnostic, linter, lintGutter } from '@codemirror/lint';
import { keymap } from '@codemirror/view';

import { fixFile, isLintableFile, lintFile } from '@/lib/biome-linter';

import type { LintDiagnostic } from '@/lib/biome-linter';
import type { Action, Diagnostic } from '@codemirror/lint';
import type { Extension } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

// =============================================================================
// Severity Mapping
// =============================================================================

function mapSeverity(severity: LintDiagnostic['severity']): Diagnostic['severity'] {
	switch (severity) {
		case 'error': {
			return 'error';
		}
		case 'warning': {
			return 'warning';
		}
		default: {
			return 'info';
		}
	}
}

// =============================================================================
// Lint Diagnostics Event
// =============================================================================

function dispatchLintDiagnostics(filePath: string, diagnostics: LintDiagnostic[]): void {
	globalThis.dispatchEvent(
		new CustomEvent('lint-diagnostics', {
			detail: { filePath, diagnostics },
		}),
	);
}

// =============================================================================
// Autofix Helpers
// =============================================================================

/**
 * Replace the entire editor document with new content.
 */
function replaceDocument(view: EditorView, newContent: string): void {
	view.dispatch({
		changes: { from: 0, to: view.state.doc.length, insert: newContent },
	});
}

/**
 * Apply all safe Biome fixes to the current document.
 */
async function applyAllFixes(view: EditorView, filename: string): Promise<boolean> {
	const content = view.state.doc.toString();
	const result = await fixFile(filename, content);
	if (!result || result.fixCount === 0) return false;
	replaceDocument(view, result.content);
	return true;
}

/**
 * Create a "Fix" action for a lint diagnostic tooltip.
 * Applies all safe fixes to the file (Biome fixes are whole-file).
 */
function createFixAction(filename: string): Action {
	return {
		name: 'Fix (Biome)',
		apply: (view: EditorView) => {
			void applyAllFixes(view, filename);
		},
	};
}

// =============================================================================
// Extension Factory
// =============================================================================

/**
 * Create a CodeMirror lint extension for the given filename.
 * Returns an empty array if the file type is not supported by Biome.
 *
 * Includes:
 * - Linter with inline diagnostics and per-diagnostic "Fix" actions
 * - Lint gutter markers
 * - Keyboard shortcuts for quick fix (Ctrl+.) and fix all (Ctrl+Shift+.)
 */
export function createLintExtension(filename: string): Extension[] {
	if (!isLintableFile(filename)) {
		return [];
	}

	const fixAction = createFixAction(filename);

	const biomeLinter = linter(
		async (view: EditorView): Promise<Diagnostic[]> => {
			const content = view.state.doc.toString();
			const lintDiagnostics = await lintFile(filename, content);

			dispatchLintDiagnostics(filename, lintDiagnostics);

			const documentLength = view.state.doc.length;

			return lintDiagnostics.map((diagnostic) => ({
				from: Math.min(diagnostic.from, documentLength),
				to: Math.min(diagnostic.to, documentLength),
				severity: mapSeverity(diagnostic.severity),
				message: diagnostic.message,
				source: diagnostic.rule ?? 'biome',
				actions: diagnostic.fixable ? [fixAction] : [],
			}));
		},
		{ delay: 400 },
	);

	const lintFixKeymap = keymap.of([
		{
			key: 'Mod-.',
			run: (view: EditorView) => {
				// Quick Fix: find the diagnostic at cursor and apply fix
				const cursorPosition = view.state.selection.main.head;
				let hasDiagnostic = false;
				forEachDiagnostic(view.state, (diagnostic) => {
					if (diagnostic.from <= cursorPosition && diagnostic.to >= cursorPosition) {
						hasDiagnostic = true;
					}
				});
				if (hasDiagnostic) {
					void applyAllFixes(view, filename);
					return true;
				}
				return false;
			},
		},
		{
			key: 'Mod-Shift-.',
			run: (view: EditorView) => {
				// Fix All: apply all safe fixes in the file
				void applyAllFixes(view, filename);
				return true;
			},
		},
	]);

	return [biomeLinter, lintGutter(), lintFixKeymap];
}
