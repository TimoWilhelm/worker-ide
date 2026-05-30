import { RangeSetBuilder, StateField, type Extension, type Text, type Transaction } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	GutterMarker,
	ViewPlugin,
	WidgetType,
	gutter,
	type DecorationSet,
	type ViewUpdate,
} from '@codemirror/view';

import { groupHunksIntoChanges, type ChangeGroup, type DiffHunk } from './diff-decorations';

const addedLineDecoration = Decoration.line({ class: 'cm-diff-added' });

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

/**
 * A single removed line rendered as a block widget.  Each removed line
 * in a diff hunk becomes its own `RemovedLineWidget` so that CodeMirror's
 * gutter system allocates a dedicated row for it (with line number and
 * diff marker).  The widget itself only renders the line content.
 */
class RemovedLineWidget extends WidgetType {
	constructor(
		readonly lineText: string,
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

class AiActionBarWidget extends WidgetType {
	constructor(
		readonly groupIndex: number,
		readonly sessionReferences: Array<{ sessionId: string; label: string }>,
		readonly onApprove: (groupIndex: number) => void,
		readonly onReject: (groupIndex: number) => void,
		readonly onOpenSession?: (sessionId: string) => void,
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

		if (this.sessionReferences.length > 0) {
			const sessionGroup = document.createElement('span');
			sessionGroup.className = 'cm-diff-action-sessions';

			for (const sessionReference of this.sessionReferences) {
				const sessionButton = document.createElement('button');
				sessionButton.className = 'cm-diff-action-session';
				sessionButton.textContent = sessionReference.label;
				sessionButton.title = `Open ${sessionReference.label}`;
				sessionButton.disabled = this.onOpenSession === undefined;
				sessionButton.addEventListener('click', (event) => {
					event.preventDefault();
					event.stopPropagation();
					this.onOpenSession?.(sessionReference.sessionId);
				});
				sessionGroup.append(sessionButton);
			}

			container.append(sessionGroup);
		}

		return container;
	}

	override eq(other: WidgetType): boolean {
		if (!(other instanceof AiActionBarWidget)) return false;
		return (
			this.groupIndex === other.groupIndex &&
			this.onApprove === other.onApprove &&
			this.onReject === other.onReject &&
			this.onOpenSession === other.onOpenSession &&
			sessionReferencesEqual(this.sessionReferences, other.sessionReferences)
		);
	}

	override get estimatedHeight(): number {
		return 28;
	}

	override ignoreEvent(): boolean {
		return true;
	}
}

function sessionReferencesEqual(
	left: Array<{ sessionId: string; label: string }>,
	right: Array<{ sessionId: string; label: string }>,
): boolean {
	if (left.length !== right.length) {
		return false;
	}

	return left.every((reference, index) => reference.sessionId === right[index]?.sessionId && reference.label === right[index]?.label);
}

type HunkStatus = 'pending' | 'approved' | 'rejected';
function resolvedHunkSet(hunks: DiffHunk[], hunkStatuses: HunkStatus[]): Set<DiffHunk> {
	if (hunkStatuses.length === 0) return new Set();
	const groups = groupHunksIntoChanges(hunks);
	const resolved = new Set<DiffHunk>();
	for (const group of groups) {
		// Only skip groups with an explicit non-pending status.
		// Out-of-bounds indices (undefined) are treated as pending so new
		// groups added during review remain visible.
		const status = hunkStatuses[group.index];
		if (status !== undefined && status !== 'pending') {
			for (const hunk of group.hunks) {
				resolved.add(hunk);
			}
		}
	}
	return resolved;
}

interface DiffLineIndex {
	/** After-document line numbers belonging to pending added hunks, ascending. */
	addedLines: number[];
	/** Pending removed hunks rendered as block widgets. */
	removedHunks: DiffHunk[];
}

/**
 * Precompute a compact index of the diff once per reconfigure so the
 * per-viewport render work is a binary search + slice instead of a full
 * hunk scan.
 */
function buildDiffLineIndex(hunks: DiffHunk[], hunkStatuses: HunkStatus[]): DiffLineIndex {
	const resolved = resolvedHunkSet(hunks, hunkStatuses);
	const addedLines: number[] = [];
	const removedHunks: DiffHunk[] = [];

	for (const hunk of hunks) {
		if (resolved.has(hunk)) continue;
		if (hunk.type === 'added') {
			for (let index = 0; index < hunk.lineCount; index++) {
				addedLines.push(hunk.startLine + index);
			}
		} else {
			removedHunks.push(hunk);
		}
	}

	// Added hunks already arrive in ascending order, but sort defensively so
	// the binary search below is always correct.
	addedLines.sort((a, b) => a - b);
	return { addedLines, removedHunks };
}

/** First index in `values` whose entry is >= `target` (lower bound). */
function lowerBound(values: number[], target: number): number {
	let low = 0;
	let high = values.length;
	while (low < high) {
		const mid = (low + high) >>> 1;
		if (values[mid] < target) {
			low = mid + 1;
		} else {
			high = mid;
		}
	}
	return low;
}

function buildAddedLineDecorations(view: EditorView, index: DiffLineIndex): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const document_ = view.state.doc;

	for (const { from, to } of view.visibleRanges) {
		const fromLine = document_.lineAt(from).number;
		const toLine = document_.lineAt(to).number;
		for (let pointer = lowerBound(index.addedLines, fromLine); pointer < index.addedLines.length; pointer++) {
			const lineNumber = index.addedLines[pointer];
			if (lineNumber > toLine) break;
			if (lineNumber > document_.lines) break;
			const line = document_.line(lineNumber);
			builder.add(line.from, line.from, addedLineDecoration);
		}
	}

	return builder.finish();
}

/**
 * Added-line background decorations, computed lazily over the visible
 * ranges only. Added-line decorations do not change line height, so
 * scoping them to the viewport is safe and keeps construction at roughly
 * O(visible lines) instead of O(total diff lines).
 */
function createAddedLinesPlugin(index: DiffLineIndex): Extension {
	return ViewPlugin.fromClass(
		class {
			decorations: DecorationSet;

			constructor(view: EditorView) {
				this.decorations = buildAddedLineDecorations(view, index);
			}

			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildAddedLineDecorations(update.view, index);
				}
			}
		},
		{
			decorations: (value) => value.decorations,
		},
	);
}

/**
 * Removed-line block widgets. Unlike added-line decorations these add
 * vertical height to the layout, so they must stay in the height map for
 * every position (not just the viewport) to keep scrolling stable.
 * CodeMirror still virtualizes their DOM via `estimatedHeight`.
 */
function buildRemovedWidgets(document_: Text, removedHunks: DiffHunk[]): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const decorations: Array<{ from: number; decoration: Decoration }> = [];

	for (const hunk of removedHunks) {
		const lineNumber = Math.min(hunk.startLine, document_.lines);
		const line = document_.line(lineNumber);

		// Emit one block widget per removed line so each gets its own gutter
		// row (line number + diff marker) from CodeMirror's native gutter
		// system.
		//
		// side ordering: more-negative → appears earlier.  Within a hunk the
		// first removed line gets the most-negative side so they render
		// top-to-bottom.  We reserve side values -1 to -999 for removed-line
		// widgets; the AI action bar uses -1000 to ensure it appears before
		// all removed lines.
		for (let index = 0; index < hunk.lineCount; index++) {
			const widget = Decoration.widget({
				widget: new RemovedLineWidget(hunk.lines[index], hunk.beforeStartLine + index),
				block: true,
				side: -(hunk.lineCount - index),
			});
			decorations.push({ from: line.from, decoration: widget });
		}
	}

	decorations.sort((a, b) => a.from - b.from || a.decoration.startSide - b.decoration.startSide);
	for (const { from, decoration } of decorations) {
		builder.add(from, from, decoration);
	}

	return builder.finish();
}

function createRemovedWidgetsField(removedHunks: DiffHunk[]): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildRemovedWidgets(state.doc, removedHunks);
		},
		update(decorations: DecorationSet, transaction: Transaction) {
			if (transaction.docChanged) {
				return buildRemovedWidgets(transaction.state.doc, removedHunks);
			}
			return decorations;
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

function buildActionBarDecorations(
	document_: Text,
	changeGroups: ChangeGroup[],
	hunkStatuses: HunkStatus[],
	hunkSessionReferences: Array<Array<{ sessionId: string; label: string }>>,
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
	onOpenSession?: (sessionId: string) => void,
): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const decorations: Array<{ from: number; decoration: Decoration }> = [];

	if (changeGroups.length === 0) return builder.finish();

	// Insert one action bar per pending change group, positioned above the group's first hunk.
	for (const group of changeGroups) {
		// Skip groups with an explicit non-pending status.
		// Out-of-bounds indices (undefined) are treated as pending.
		const status = hunkStatuses[group.index];
		if (status !== undefined && status !== 'pending') continue;
		const hunkLine = Math.min(group.startLine, document_.lines);
		const line = document_.line(hunkLine);
		const actionWidget = Decoration.widget({
			widget: new AiActionBarWidget(group.index, hunkSessionReferences[group.index] ?? [], onApprove, onReject, onOpenSession),
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
	hunkStatuses: HunkStatus[],
	hunkSessionReferences: Array<Array<{ sessionId: string; label: string }>>,
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
	onOpenSession?: (sessionId: string) => void,
): Extension {
	return StateField.define<DecorationSet>({
		create(state) {
			return buildActionBarDecorations(state.doc, changeGroups, hunkStatuses, hunkSessionReferences, onApprove, onReject, onOpenSession);
		},
		update(decorations: DecorationSet, transaction: Transaction) {
			if (transaction.docChanged) {
				return buildActionBarDecorations(
					transaction.state.doc,
					changeGroups,
					hunkStatuses,
					hunkSessionReferences,
					onApprove,
					onReject,
					onOpenSession,
				);
			}
			return decorations;
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});
}

function createDiffGutter(index: DiffLineIndex): Extension {
	return gutter({
		class: 'cm-diff-gutter',
		markers(view) {
			const builder = new RangeSetBuilder<GutterMarker>();
			const document_ = view.state.doc;

			// Added-line markers are scoped to the visible ranges; removed
			// lines get their "−" via `widgetMarker` below.
			for (const { from, to } of view.visibleRanges) {
				const fromLine = document_.lineAt(from).number;
				const toLine = document_.lineAt(to).number;
				for (let pointer = lowerBound(index.addedLines, fromLine); pointer < index.addedLines.length; pointer++) {
					const lineNumber = index.addedLines[pointer];
					if (lineNumber > toLine) break;
					if (lineNumber > document_.lines) break;
					const line = document_.line(lineNumber);
					builder.add(line.from, line.from, addedMarker);
				}
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

const coreDiffTheme = EditorView.baseTheme({
	'.cm-diff-added': {
		backgroundColor: 'color-mix(in srgb, var(--color-success) 10%, transparent)',
	},
	// Each removed line is its own block widget. The gutter line
	// number and "−" marker are rendered natively by CodeMirror; this
	// only styles the content area.
	'.cm-diff-removed-line': {
		backgroundColor: 'color-mix(in srgb, var(--color-error) 12%, transparent)',
		color: 'var(--color-error)',
		opacity: '0.85',
		whiteSpace: 'pre',
		'& del': {
			textDecoration: 'none',
			padding: '0 4px',
		},
	},
	'.cm-diff-gutter': {
		width: '12px',
	},
	'.cm-diff-gutter-added': {
		color: 'var(--color-success)',
		fontWeight: 'bold',
		fontSize: '12px',
	},
	'.cm-diff-gutter-removed': {
		color: 'var(--color-error)',
		fontWeight: 'bold',
		fontSize: '12px',
	},
});

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
	'.cm-diff-action-sessions': {
		display: 'flex',
		flexWrap: 'wrap',
		gap: '4px',
		marginLeft: '6px',
	},
	'.cm-diff-action-session': {
		cursor: 'pointer',
		padding: '2px 8px',
		borderRadius: '9999px',
		border: '1px solid color-mix(in srgb, var(--color-accent) 20%, transparent)',
		backgroundColor: 'color-mix(in srgb, var(--color-bg-secondary) 88%, transparent)',
		color: 'var(--color-accent)',
		fontSize: '11px',
		fontWeight: '600',
		'&:hover': {
			backgroundColor: 'color-mix(in srgb, var(--color-accent) 12%, transparent)',
		},
		'&:disabled': {
			cursor: 'default',
			opacity: '0.75',
		},
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

/**
 * Create core diff decoration extensions (line highlights, removed line widgets, gutter).
 * Used by both AI change review and read-only git diffs.
 * Does NOT include the AI accept/reject action bar.
 *
 * @param hunkStatuses - When provided, decorations for resolved (non-pending) change groups are hidden.
 */
export function createDiffDecorations(hunks: DiffHunk[], hunkStatuses: HunkStatus[] = []): Extension[] {
	if (hunks.length === 0) return [];
	const index = buildDiffLineIndex(hunks, hunkStatuses);
	return [coreDiffTheme, createDiffGutter(index), createAddedLinesPlugin(index), createRemovedWidgetsField(index.removedHunks)];
}

/**
 * Create the AI-specific inline action bar extension (per-change accept/reject buttons).
 * Hunks are grouped into logical changes (replacement, addition, removal) and each
 * pending group gets its own inline action bar. Resolved groups are skipped.
 * Should only be used during AI change review, never for git diffs.
 */
export function createAiActionBarExtension(
	hunks: DiffHunk[],
	hunkStatuses: HunkStatus[],
	hunkSessionReferences: Array<Array<{ sessionId: string; label: string }>>,
	onApprove: (groupIndex: number) => void,
	onReject: (groupIndex: number) => void,
	onOpenSession?: (sessionId: string) => void,
): Extension[] {
	if (hunks.length === 0) return [];
	const changeGroups = groupHunksIntoChanges(hunks);
	return [aiActionBarTheme, createAiActionBarField(changeGroups, hunkStatuses, hunkSessionReferences, onApprove, onReject, onOpenSession)];
}
