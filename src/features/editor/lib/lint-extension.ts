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

import { applySingleFix, fixFile, isLintableFile, lintFile } from '@/lib/biome-linter';

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

export function dispatchLintDiagnostics(filePath: string, diagnostics: LintDiagnostic[]): void {
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
	dispatchLintDiagnostics(filename, result.remainingDiagnostics);
	return true;
}

/**
 * Create a "Fix" action for a specific lint diagnostic.
 * Uses workspace.pullActions to apply the fix for just this diagnostic's span.
 */
function createFixAction(filename: string, from: number, to: number): Action {
	return {
		name: 'Fix',
		apply: (view: EditorView) => {
			const content = view.state.doc.toString();
			void applySingleFix(filename, content, from, to).then((fixedContent) => {
				if (fixedContent !== undefined) {
					replaceDocument(view, fixedContent);
				}
			});
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

	const biomeLinter = linter(
		async (view: EditorView): Promise<Diagnostic[]> => {
			const content = view.state.doc.toString();
			const lintDiagnostics = await lintFile(filename, content);

			dispatchLintDiagnostics(filename, lintDiagnostics);

			const documentLength = view.state.doc.length;

			return lintDiagnostics.map((diagnostic) => {
				const from = Math.min(diagnostic.from, documentLength);
				const to = Math.min(diagnostic.to, documentLength);
				return {
					from,
					to,
					severity: mapSeverity(diagnostic.severity),
					message: diagnostic.message,
					source: diagnostic.rule ?? 'biome',
					actions: diagnostic.fixable ? [createFixAction(filename, from, to)] : [],
				};
			});
		},
		{ delay: 400 },
	);

	const lintFixKeymap = keymap.of([
		{
			key: 'Mod-.',
			run: (view: EditorView) => {
				// Quick Fix: apply fix for the first fixable diagnostic at cursor
				const cursorPosition = view.state.selection.main.head;
				let targetFrom: number | undefined;
				let targetTo: number | undefined;
				forEachDiagnostic(view.state, (diagnostic) => {
					if (
						targetFrom === undefined &&
						diagnostic.from <= cursorPosition &&
						diagnostic.to >= cursorPosition &&
						diagnostic.actions &&
						diagnostic.actions.length > 0
					) {
						targetFrom = diagnostic.from;
						targetTo = diagnostic.to;
					}
				});
				if (targetFrom !== undefined && targetTo !== undefined) {
					const content = view.state.doc.toString();
					void applySingleFix(filename, content, targetFrom, targetTo).then((fixedContent) => {
						if (fixedContent !== undefined) {
							replaceDocument(view, fixedContent);
						}
					});
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
		{
			key: 'Shift-Alt-f',
			run: (view: EditorView) => {
				// Prettify: apply all safe fixes (same as Fix All, standard format shortcut)
				void applyAllFixes(view, filename);
				return true;
			},
		},
	]);

	return [biomeLinter, lintGutter(), lintFixKeymap];
}
