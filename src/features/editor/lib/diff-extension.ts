/**
 * CodeMirror Diff Extension
 *
 * Provides inline diff decorations for the editor: green backgrounds for
 * added lines, red widget decorations for removed lines, and gutter markers.
 *
 * Removed lines are rendered as individual block widgets (one per line) so
 * that each participates in CodeMirror's native gutter system.  The
 * `lineNumberWidgetMarker` facet gives each widget a proper line number in
 * the line-number gutter, and `widgetMarker` on the diff gutter gives each
 * widget a "−" marker — no fake HTML gutters needed.
 *
 * Split into two independent extension sets:
 * - `createDiffDecorations()` — Core diff line/gutter decorations. Used by
 *   both AI change review and read-only git diffs.
 * - `createAiActionBarExtension()` — Inline "AI Change" accept/reject bar.
 *   Only used during AI change review.
 */

import { RangeSetBuilder, StateField, type Extension, type Text, type Transaction } from '@codemirror/state';
import { Decoration, EditorView, GutterMarker, WidgetType, gutter, type DecorationSet } from '@codemirror/view';

import { groupHunksIntoChanges, type ChangeGroup, type DiffHunk } from './diff-decorations';

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
// Removed line widget — one per removed line for native gutter integration
// =============================================================================

/**
 * A single removed line rendered as a block widget.  Each removed line
 * in a diff hunk becomes its own `RemovedLineWidget` so that CodeMirror's
 * gutter system allocates a dedicated row for it (with line number and
 * diff marker).  The widget itself only renders the line content.
 */
class RemovedLineWidget extends WidgetType {
	constructor(
		/** Text content of the removed line */
		readonly lineText: string,
		/** 1-indexed line number in the original (before) document */
		readonly beforeLineNumber: number,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const element = document.createElement('div');
		element.className = 'cm-diff-removed-line';
		const content = document.createElement('del');
		content.textContent = this.lineText || '\u00A0'; // non-breaking space for empty lines
		element.append(content);
		return element;
	}

	override eq(other: WidgetType): boolean {
		return other instanceof RemovedLineWidget && other.lineText === this.lineText && other.beforeLineNumber === this.beforeLineNumber;
	}

	override get estimatedHeight(): number {
		return 20;
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
		readonly groupIndex: number,
		readonly onApprove: (groupIndex: number) => void,
		readonly onReject: (groupIndex: number) => void,
	) {
		super();
	}

	toDOM(): HTMLElement {
		const container = document.createElement('div');
		container.className = 'cm-diff-action-bar';

		const buttonGroup = document.createElement('span');
		buttonGroup.className = 'cm-diff-action-buttons';

		const acceptButton = document.createElement('button');
		acceptButton.className = 'cm-diff-action-accept';
		acceptButton.textContent = '\u2713 Accept';
		acceptButton.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.onApprove(this.groupIndex);
		});
		buttonGroup.append(acceptButton);

		const rejectButton = document.createElement('button');
		rejectButton.className = 'cm-diff-action-reject';
		rejectButton.textContent = '\u2717 Reject';
		rejectButton.addEventListener('click', (event) => {
			event.preventDefault();
			event.stopPropagation();
			this.onReject(this.groupIndex);
		});
		buttonGroup.append(rejectButton);

		container.append(buttonGroup);
		return container;
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof AiActionBarWidget)) return false;
		return this.groupIndex === other.groupIndex && this.onApprove === other.onApprove && this.onReject === other.onReject;
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

			// Emit one block widget per removed line so each gets its own
			// gutter row (line number + diff marker) from CodeMirror's
			// native gutter system.
			//
			// side ordering: more-negative → appears earlier.  Within a
			// hunk the first removed line gets the most-negative side so
			// they render top-to-bottom.  We reserve side values -1 to
			// -999 for removed-line widgets; the AI action bar uses
			// -1000 to ensure it appears before all removed lines.
			for (let index = 0; index < hunk.lineCount; index++) {
				const widget = Decoration.widget({
					widget: new RemovedLineWidget(hunk.lines[index], hunk.beforeStartLine + index),
					block: true,
					side: -(hunk.lineCount - index),
				});
				decorations.push({ from: line.from, to: line.from, decoration: widget });
			}
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

function buildActionBarDecorations(
	document_: Text,
	changeGroups: ChangeGroup[],
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const decorations: Array<{ from: number; decoration: Decoration }> = [];

	if (changeGroups.length === 0) return builder.finish();

	// Insert one action bar per change group, positioned above the group's first hunk.
	for (const group of changeGroups) {
		const hunkLine = Math.min(group.startLine, document_.lines);
		const line = document_.line(hunkLine);
		const actionWidget = Decoration.widget({
			widget: new AiActionBarWidget(group.index, onApprove, onReject),
			block: true,
			// Each action bar needs a unique side value below all removed-line
			// widgets at the same position.  Removed lines use -1 to -999;
			// action bars use -1001, -1002, ... (one per group).
			side: -(1001 + group.index),
		});
		decorations.push({ from: line.from, decoration: actionWidget });
	}

	decorations.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
	for (const { from, decoration } of decorations) {
		builder.add(from, from, decoration);
	}

	return builder.finish();
}

function createAiActionBarField(
	changeGroups: ChangeGroup[],
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildActionBarDecorations(state.doc, changeGroups, onApprove, onReject);
		},
		update(decorations: DecorationSet, transaction: Transaction) {
			if (transaction.docChanged) {
				return buildActionBarDecorations(transaction.state.doc, changeGroups, onApprove, onReject);
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

			// Only added lines need markers from the rangeset — removed
			// lines get their "−" via `widgetMarker` below.
			for (const hunk of hunks) {
				if (hunk.type === 'added') {
					for (let index = 0; index < hunk.lineCount; index++) {
						const lineNumber = hunk.startLine + index;
						if (lineNumber > document_.lines) break;
						const line = document_.line(lineNumber);
						markers.push({ from: line.from, marker: addedMarker });
					}
				}
			}

			markers.sort((a, b) => a.from - b.from);

			for (const { from, marker } of markers) {
				builder.add(from, from, marker);
			}

			return builder.finish();
		},

		// Give each RemovedLineWidget block its own "−" gutter entry.

		widgetMarker: (_view, widget) => {
			if (widget instanceof RemovedLineWidget) return removedMarker;
			// eslint-disable-next-line unicorn/no-null -- CodeMirror API requires null
			return null;
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
	// Each removed line is its own block widget.  The gutter line
	// number and "−" marker are rendered natively by CodeMirror; this
	// only styles the content area.
	'.cm-diff-removed-line': {
		backgroundColor: 'rgba(255, 94, 94, 0.08)',
		color: 'rgba(255, 94, 94, 0.7)',
		whiteSpace: 'pre',
		'& del': {
			textDecoration: 'line-through',
			padding: '0 4px',
		},
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
		backgroundColor: 'color-mix(in srgb, var(--color-accent) 8%, transparent)',
		borderBottom: '1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)',
		fontFamily: 'system-ui, sans-serif',
		fontSize: '11px',
	},
	'.cm-diff-action-label': {
		color: 'var(--color-accent)',
		fontWeight: '600',
	},
	'.cm-diff-action-buttons': {
		display: 'flex',
		gap: '4px',
	},
	'.cm-diff-action-accept': {
		cursor: 'pointer',
		padding: '2px 10px',
		borderRadius: '4px',
		border: 'none',
		backgroundColor: 'color-mix(in srgb, var(--color-success) 12%, transparent)',
		color: 'var(--color-success)',
		fontSize: '11px',
		fontWeight: '600',
		'&:hover': {
			backgroundColor: 'color-mix(in srgb, var(--color-success) 22%, transparent)',
		},
	},
	'.cm-diff-action-reject': {
		cursor: 'pointer',
		padding: '2px 10px',
		borderRadius: '4px',
		border: 'none',
		backgroundColor: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
		color: 'var(--color-error)',
		fontSize: '11px',
		fontWeight: '600',
		'&:hover': {
			backgroundColor: 'color-mix(in srgb, var(--color-error) 22%, transparent)',
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
 * Create the AI-specific inline action bar extension (per-change accept/reject buttons).
 * Hunks are grouped into logical changes (replacement, addition, removal) and each
 * group gets its own inline action bar.
 * Should only be used during AI change review, never for git diffs.
 */
export function createAiActionBarExtension(
	hunks: DiffHunk[],
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
): Extension[] {
	if (hunks.length === 0) return [];
	const changeGroups = groupHunksIntoChanges(hunks);
	return [aiActionBarTheme, createAiActionBarField(changeGroups, onApprove, onReject)];
}
