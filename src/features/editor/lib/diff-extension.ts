/**
 * CodeMirror Diff Extension
 *
 * Provides inline diff decorations for the editor: green backgrounds for
 * added lines, red widget decorations for removed lines, and gutter markers.
 *
 * Split into two independent extension sets:
 * - `createDiffDecorations()` — Core diff line/gutter decorations. Used by
 *   both AI change review and read-only git diffs.
 * - `createAiActionBarExtension()` — Inline "AI Change" accept/reject bar.
 *   Only used during AI change review.
 */

import { RangeSetBuilder, StateField, type Extension, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from '@codemirror/view';

import type { DiffHunk } from './diff-decorations';

// =============================================================================
// Types
// =============================================================================

export interface DiffExtensionConfig {
	hunks: DiffHunk[];
	onApprove?: () => void;
	onReject?: () => void;
}

// =============================================================================
// Core decoration marks
// =============================================================================

const addedLineDecoration = Decoration.line({ class: 'cm-diff-added' });

// =============================================================================
// Gutter markers
// =============================================================================

class AddedGutterMarker extends GutterMarker {
	toDOM(): Node {
		const element = document.createElement('span');
		element.textContent = '+';
		element.className = 'cm-diff-gutter-added';
		return element;
	}
}

class RemovedGutterMarker extends GutterMarker {
	toDOM(): Node {
		const element = document.createElement('span');
		element.textContent = '−';
		element.className = 'cm-diff-gutter-removed';
		return element;
	}
}

const addedMarker = new AddedGutterMarker();
const removedMarker = new RemovedGutterMarker();

// =============================================================================
// Removed lines widget (core — used by both AI and git diffs)
// =============================================================================

class RemovedLinesWidget extends WidgetType {
	constructor(readonly lines: string[]) {
		super();
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'cm-diff-removed-block';

		for (const line of this.lines) {
			const lineElement = document.createElement('div');
			lineElement.className = 'cm-diff-removed-line';
			lineElement.textContent = line || '\u00A0'; // non-breaking space for empty lines
			container.append(lineElement);
		}

		return container;
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof RemovedLinesWidget)) return false;
		if (this.lines.length !== other.lines.length) return false;
		return this.lines.every((line, index) => line === other.lines[index]);
	}

	override get estimatedHeight(): number {
		return this.lines.length * 20;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

// =============================================================================
// AI action bar widget (AI-only — accept/reject at first hunk)
// =============================================================================

class AiActionBarWidget extends WidgetType {
	constructor(
		readonly onApprove: () => void,
		readonly onReject: () => void,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'cm-diff-action-bar';

		const label = document.createElement('span');
		label.className = 'cm-diff-action-label';
		label.textContent = 'AI Change';
		container.append(label);

		const buttonGroup = document.createElement('span');
		buttonGroup.className = 'cm-diff-action-buttons';

		const acceptButton = document.createElement('button');
		acceptButton.className = 'cm-diff-action-accept';
		acceptButton.textContent = '\u2713 Accept';
		acceptButton.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.onApprove();
		});
		buttonGroup.append(acceptButton);

		const rejectButton = document.createElement('button');
		rejectButton.className = 'cm-diff-action-reject';
		rejectButton.textContent = '\u2717 Reject';
		rejectButton.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.onReject();
		});
		buttonGroup.append(rejectButton);

		container.append(buttonGroup);
		return container;
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof AiActionBarWidget)) return false;
		return this.onApprove === other.onApprove && this.onReject === other.onReject;
	}

	override get estimatedHeight(): number {
		return 28;
	}

	override ignoreEvent(): boolean {
		return false;
	}
}

// =============================================================================
// Core diff decorations (no action bar)
// =============================================================================

function buildCoreDecorations(document_: Text, hunks: DiffHunk[]): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];

	for (const hunk of hunks) {
		if (hunk.type === 'added') {
			for (let index = 0; index < hunk.lineCount; index++) {
				const lineNumber = hunk.startLine + index;
				if (lineNumber > document_.lines) break;
				const line = document_.line(lineNumber);
				decorations.push({ from: line.from, to: line.from, decoration: addedLineDecoration });
			}
		} else if (hunk.type === 'removed') {
			const lineNumber = Math.min(hunk.startLine, document_.lines);
			const line = document_.line(lineNumber);
			const widget = Decoration.widget({
				widget: new RemovedLinesWidget(hunk.lines),
				block: true,
				side: -1,
			});
			decorations.push({ from: line.from, to: line.from, decoration: widget });
		}
	}

	decorations.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);

	for (const { from, to, decoration } of decorations) {
		builder.add(from, to, decoration);
	}

	return builder.finish();
}

function createCoreDiffField(hunks: DiffHunk[]): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildCoreDecorations(state.doc, hunks);
		},
		update(decorations: DecorationSet, transaction: Transaction) {
			if (transaction.docChanged) {
				return buildCoreDecorations(transaction.state.doc, hunks);
			}
			return decorations;
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

// =============================================================================
// AI action bar extension (separate from core decorations)
// =============================================================================

function buildActionBarDecoration(document_: Text, hunks: DiffHunk[], onApprove: () => void, onReject: () => void): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();

	if (hunks.length === 0) return builder.finish();

	// Insert action bar above the first hunk
	const firstHunk = hunks[0];
	const hunkLine = Math.min(firstHunk.startLine, document_.lines);
	const line = document_.line(hunkLine);
	const actionWidget = Decoration.widget({
		widget: new AiActionBarWidget(onApprove, onReject),
		block: true,
		side: -2, // before removed-lines widgets (-1)
	});
	builder.add(line.from, line.from, actionWidget);

	return builder.finish();
}

function createAiActionBarField(hunks: DiffHunk[], onApprove: () => void, onReject: () => void): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildActionBarDecoration(state.doc, hunks, onApprove, onReject);
		},
		update(decorations: DecorationSet, transaction: Transaction) {
			if (transaction.docChanged) {
				return buildActionBarDecoration(transaction.state.doc, hunks, onApprove, onReject);
			}
			return decorations;
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

// =============================================================================
// Gutter extension
// =============================================================================

function createDiffGutter(hunks: DiffHunk[]): Extension {
	return gutter({
		class: 'cm-diff-gutter',
		markers(view) {
			const builder = new RangeSetBuilder<GutterMarker>();
			const document_ = view.state.doc;
			const markers: Array<{ from: number; marker: GutterMarker }> = [];

			for (const hunk of hunks) {
				if (hunk.type === 'added') {
					for (let index = 0; index < hunk.lineCount; index++) {
						const lineNumber = hunk.startLine + index;
						if (lineNumber > document_.lines) break;
						const line = document_.line(lineNumber);
						markers.push({ from: line.from, marker: addedMarker });
					}
				} else if (hunk.type === 'removed') {
					const lineNumber = Math.min(hunk.startLine, document_.lines);
					const line = document_.line(lineNumber);
					markers.push({ from: line.from, marker: removedMarker });
				}
			}

			markers.sort((a, b) => a.from - b.from || a.marker.startSide - b.marker.startSide);

			for (const { from, marker } of markers) {
				builder.add(from, from, marker);
			}

			return builder.finish();
		},
	});
}

// =============================================================================
// Theme — core diff styles (used by both AI and git diffs)
// =============================================================================

const coreDiffTheme = EditorView.baseTheme({
	'.cm-diff-added': {
		backgroundColor: 'rgba(94, 255, 58, 0.08)',
	},
	'.cm-diff-removed-block': {
		backgroundColor: 'rgba(255, 94, 94, 0.08)',
		borderLeft: '2px solid rgba(255, 94, 94, 0.4)',
		padding: '0',
		fontFamily: 'var(--font-mono)',
		fontSize: 'var(--text-base)',
	},
	'.cm-diff-removed-line': {
		padding: '0 4px',
		color: 'rgba(255, 94, 94, 0.7)',
		textDecoration: 'line-through',
		whiteSpace: 'pre',
		lineHeight: '1.4',
	},
	'.cm-diff-gutter': {
		width: '12px',
	},
	'.cm-diff-gutter-added': {
		color: 'rgba(94, 255, 58, 0.8)',
		fontWeight: 'bold',
		fontSize: '12px',
	},
	'.cm-diff-gutter-removed': {
		color: 'rgba(255, 94, 94, 0.8)',
		fontWeight: 'bold',
		fontSize: '12px',
	},
});

// =============================================================================
// Theme — AI action bar styles (only loaded when action bar is shown)
// =============================================================================

const aiActionBarTheme = EditorView.baseTheme({
	'.cm-diff-action-bar': {
		display: 'flex',
		alignItems: 'center',
		gap: '8px',
		padding: '2px 8px',
		backgroundColor: 'rgba(94, 160, 255, 0.08)',
		borderBottom: '1px solid rgba(94, 160, 255, 0.2)',
		fontFamily: 'system-ui, sans-serif',
		fontSize: '11px',
	},
	'.cm-diff-action-label': {
		color: 'rgba(94, 160, 255, 0.8)',
		fontWeight: '600',
	},
	'.cm-diff-action-buttons': {
		display: 'flex',
		gap: '4px',
	},
	'.cm-diff-action-accept': {
		cursor: 'pointer',
		padding: '1px 8px',
		borderRadius: '3px',
		border: 'none',
		backgroundColor: 'rgba(94, 255, 58, 0.12)',
		color: 'rgba(94, 255, 58, 0.9)',
		fontSize: '11px',
		fontWeight: '500',
		'&:hover': {
			backgroundColor: 'rgba(94, 255, 58, 0.2)',
		},
	},
	'.cm-diff-action-reject': {
		cursor: 'pointer',
		padding: '1px 8px',
		borderRadius: '3px',
		border: 'none',
		backgroundColor: 'rgba(255, 94, 94, 0.12)',
		color: 'rgba(255, 94, 94, 0.9)',
		fontSize: '11px',
		fontWeight: '500',
		'&:hover': {
			backgroundColor: 'rgba(255, 94, 94, 0.2)',
		},
	},
});

// =============================================================================
// Public API
// =============================================================================

/**
 * Create core diff decoration extensions (line highlights, removed line widgets, gutter).
 * Used by both AI change review and read-only git diffs.
 * Does NOT include the AI accept/reject action bar.
 */
export function createDiffDecorations(hunks: DiffHunk[]): Extension[] {
	if (hunks.length === 0) return [];
	return [coreDiffTheme, createDiffGutter(hunks), createCoreDiffField(hunks)];
}

/**
 * Create the AI-specific inline action bar extension (accept/reject buttons).
 * Should only be used during AI change review, never for git diffs.
 */
export function createAiActionBarExtension(hunks: DiffHunk[], onApprove: () => void, onReject: () => void): Extension[] {
	if (hunks.length === 0) return [];
	return [aiActionBarTheme, createAiActionBarField(hunks, onApprove, onReject)];
}

/**
 * Create a set of CodeMirror extensions for displaying inline diffs.
 * Composes core decorations + optional AI action bar.
 *
 * @deprecated Prefer using `createDiffDecorations()` and `createAiActionBarExtension()`
 * separately for clearer separation of concerns.
 */
export function createDiffExtensions(config: DiffExtensionConfig): Extension[] {
	if (config.hunks.length === 0) return [];

	const extensions = createDiffDecorations(config.hunks);

	if (config.onApprove && config.onReject) {
		extensions.push(...createAiActionBarExtension(config.hunks, config.onApprove, config.onReject));
	}

	return extensions;
}
