/**
 * CodeMirror Diff Extension
 *
 * Provides inline diff decorations for the editor: green backgrounds for
 * added lines, red widget decorations for removed lines, and gutter markers.
 */

import { RangeSetBuilder } from '@codemirror/state';
import {
	Decoration,
	EditorView,
	GutterMarker,
	ViewPlugin,
	WidgetType,
	gutter,
	type DecorationSet,
	type PluginValue,
	type ViewUpdate,
} from '@codemirror/view';

import type { DiffHunk } from './diff-decorations';
import type { Extension } from '@codemirror/state';

// =============================================================================
// Types
// =============================================================================

export interface DiffExtensionConfig {
	hunks: DiffHunk[];
	onApproveHunk?: (hunkIndex: number) => void;
	onRejectHunk?: (hunkIndex: number) => void;
}

// =============================================================================
// Decoration marks
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
// Removed lines widget
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
// View plugin — builds decorations from hunks
// =============================================================================

function buildDecorations(view: EditorView, hunks: DiffHunk[]): DecorationSet {
	const builder = new RangeSetBuilder<Decoration>();
	const document_ = view.state.doc;

	// Collect all decorations, sorted by position
	const decorations: Array<{ from: number; to: number; decoration: Decoration }> = [];

	for (const hunk of hunks) {
		if (hunk.type === 'added') {
			// Highlight added lines with green background
			for (let index = 0; index < hunk.lineCount; index++) {
				const lineNumber = hunk.startLine + index;
				if (lineNumber > document_.lines) break;
				const line = document_.line(lineNumber);
				decorations.push({ from: line.from, to: line.from, decoration: addedLineDecoration });
			}
		} else if (hunk.type === 'removed') {
			// Show removed lines as a widget above the current line
			const lineNumber = Math.min(hunk.startLine, document_.lines);
			const line = document_.line(lineNumber);
			const widget = Decoration.widget({
				widget: new RemovedLinesWidget(hunk.lines),
				block: true,
				side: -1, // above the line
			});
			decorations.push({ from: line.from, to: line.from, decoration: widget });
		}
	}

	// Sort by position (required by RangeSetBuilder)
	decorations.sort((a, b) => a.from - b.from || a.to - b.to);

	for (const { from, to, decoration } of decorations) {
		builder.add(from, to, decoration);
	}

	return builder.finish();
}

function createDiffPlugin(hunks: DiffHunk[]): ViewPlugin<PluginValue & { decorations: DecorationSet }> {
	return ViewPlugin.define(
		(view) => ({
			decorations: buildDecorations(view, hunks),
			update(update: ViewUpdate) {
				if (update.docChanged || update.viewportChanged) {
					this.decorations = buildDecorations(update.view, hunks);
				}
			},
		}),
		{
			decorations: (value) => value.decorations,
		},
	);
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

			// Collect markers sorted by position
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

			markers.sort((a, b) => a.from - b.from);

			for (const { from, marker } of markers) {
				builder.add(from, from, marker);
			}

			return builder.finish();
		},
	});
}

// =============================================================================
// Theme
// =============================================================================

const diffTheme = EditorView.baseTheme({
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
// Public API
// =============================================================================

/**
 * Create a set of CodeMirror extensions for displaying inline diffs.
 * Returns an empty array if there are no hunks.
 */
export function createDiffExtensions(config: DiffExtensionConfig): Extension[] {
	if (config.hunks.length === 0) return [];

	return [diffTheme, createDiffGutter(config.hunks), createDiffPlugin(config.hunks)];
}
