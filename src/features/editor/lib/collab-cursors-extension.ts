/**
 * CodeMirror Extension for Remote Collaboration Cursors
 *
 * Renders remote participant cursors as absolutely-positioned elements
 * in a layer div (the same technique CM6 uses for its own cursor).
 * Selections are rendered as mark decorations with a translucent background.
 */

import { type Extension, RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, type DecorationSet, layer, RectangleMarker } from '@codemirror/view';

import type { Participant } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

/**
 * A remote cursor to render, pre-filtered to participants in the current file.
 */
export interface RemoteCursor {
	/** Participant display color (hex) */
	color: string;
	/** Cursor position: 1-based line, 1-based ch */
	cursor: { line: number; ch: number };
	/** Optional selection range (1-based line/ch) */
	selection?: {
		anchor: { line: number; ch: number };
		head: { line: number; ch: number };
	};
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Convert a 1-based {line, ch} position to a 0-based document offset,
 * clamped to valid bounds.
 */
function toOffset(
	document_: { lines: number; line: (n: number) => { from: number; length: number } },
	position: { line: number; ch: number },
): number {
	const lineNumber = Math.max(1, Math.min(position.line, document_.lines));
	const line = document_.line(lineNumber);
	const column = Math.max(0, Math.min(position.ch - 1, line.length));
	return line.from + column;
}

/**
 * Compute the base coordinates for converting viewport-relative coords
 * to scroll-content-relative coords (same logic CM6 uses internally).
 */
function getBase(view: EditorView): { left: number; top: number } {
	const rect = view.scrollDOM.getBoundingClientRect();
	return {
		left: rect.left - view.scrollDOM.scrollLeft,
		top: rect.top - view.scrollDOM.scrollTop,
	};
}

/**
 * Filter participants to remote cursors in the current file.
 */
function filterRemoteCursors(participants: Participant[], activeFile: string | undefined, localId: string | undefined): RemoteCursor[] {
	const remoteCursors: RemoteCursor[] = [];
	for (const participant of participants) {
		if (participant.id === localId) continue;
		if (!participant.cursor || participant.file !== activeFile) continue;
		remoteCursors.push({
			color: participant.color,
			cursor: participant.cursor,
			selection: participant.selection,
		});
	}
	return remoteCursors;
}

// =============================================================================
// Cursor Layer Marker
// =============================================================================

/**
 * A marker for a single remote cursor, rendered as a colored bar.
 * Extends RectangleMarker to use CM6's built-in layer reconciliation.
 */
class RemoteCursorMarker extends RectangleMarker {
	constructor(
		readonly color: string,
		left: number,
		top: number,
		height: number,
	) {
		// eslint-disable-next-line unicorn/no-null -- CM6 API requires null for "no width"
		super('remote-cursor', left, top, null, height);
		this.color = color;
	}

	override draw(): HTMLDivElement {
		const element = super.draw();
		element.style.backgroundColor = this.color;
		return element;
	}

	override eq(other: RectangleMarker): boolean {
		return other instanceof RemoteCursorMarker && this.color === other.color && super.eq(other);
	}
}

// =============================================================================
// Selection Decoration Builder
// =============================================================================

/** Hex color pattern for sanitising remote participant colors. */
const HEX_COLOR_RE = /^#[\da-f]{6}$/i;

/** Fallback color when an invalid color string is received. */
const FALLBACK_COLOR = '#888888';

/** Sanitise a color string — only allow valid 6-digit hex. */
function sanitizeColor(color: string): string {
	return HEX_COLOR_RE.test(color) ? color : FALLBACK_COLOR;
}

/**
 * Build a DecorationSet containing only selection mark decorations.
 */
function buildSelectionDecorations(cursors: RemoteCursor[], view: EditorView): DecorationSet {
	const document_ = view.state.doc;
	const marks: Array<{ from: number; to: number; decoration: Decoration }> = [];

	for (const remote of cursors) {
		if (!remote.selection) continue;
		const anchorOffset = toOffset(document_, remote.selection.anchor);
		const headOffset = toOffset(document_, remote.selection.head);
		const from = Math.min(anchorOffset, headOffset);
		const to = Math.max(anchorOffset, headOffset);

		if (from !== to) {
			const safeColor = sanitizeColor(remote.color);
			marks.push({
				from,
				to,
				decoration: Decoration.mark({
					class: 'remote-selection',
					attributes: { style: `background: color-mix(in srgb, ${safeColor} 15%, transparent)` },
				}),
			});
		}
	}

	marks.sort((a, b) => a.from - b.from || a.to - b.to);

	const builder = new RangeSetBuilder<Decoration>();
	for (const { from, to, decoration } of marks) {
		builder.add(from, to, decoration);
	}
	return builder.finish();
}

// =============================================================================
// Public API
// =============================================================================

/**
 * Create the collaboration cursors extension.
 *
 * Each call creates its own StateEffect/StateField/layer instances so
 * multiple editor views never share mutable CM6 state.
 *
 * Returns the extension and a function to update the remote cursors.
 */
export function createCollabCursorsExtension(): {
	extension: Extension;
	update: (view: EditorView, participants: Participant[], activeFile: string | undefined, localId: string | undefined) => void;
} {
	// ── Per-instance CM6 state ────────────────────────────────────────

	/** Effect to update the set of remote cursors. */
	const setRemoteCursorsEffect = StateEffect.define<RemoteCursor[]>();

	/** StateField that stores the current remote cursor data. */
	const remoteCursorsState = StateField.define<RemoteCursor[]>({
		create() {
			return [];
		},
		update(cursors, transaction) {
			for (const effect of transaction.effects) {
				if (effect.is(setRemoteCursorsEffect)) {
					return effect.value;
				}
			}
			return cursors;
		},
	});

	const remoteCursorLayer = layer({
		above: true,
		class: 'remote-cursor-layer',
		markers(view) {
			const cursors = view.state.field(remoteCursorsState);
			if (cursors.length === 0) return [];

			const base = getBase(view);
			const markers: RectangleMarker[] = [];

			for (const remote of cursors) {
				const safeColor = sanitizeColor(remote.color);
				const offset = toOffset(view.state.doc, remote.cursor);
				const coords = view.coordsAtPos(offset, 1);
				if (!coords) continue;

				markers.push(new RemoteCursorMarker(safeColor, coords.left - base.left, coords.top - base.top, coords.bottom - coords.top));
			}

			return markers;
		},
		update(update) {
			return (
				update.docChanged ||
				update.viewportChanged ||
				update.transactions.some((tr) => tr.effects.some((effect) => effect.is(setRemoteCursorsEffect)))
			);
		},
	});

	/** Effect to set pre-built selection decorations. */
	const setSelectionDecorations = StateEffect.define<DecorationSet>();

	/** StateField for remote selection mark decorations. */
	const remoteSelectionsField = StateField.define<DecorationSet>({
		create() {
			return Decoration.none;
		},
		update(decorations, transaction) {
			for (const effect of transaction.effects) {
				if (effect.is(setSelectionDecorations)) {
					return effect.value;
				}
			}
			// eslint-disable-next-line unicorn/no-array-callback-reference -- DecorationSet.map takes a ChangeDesc, not Array.map
			return decorations.map(transaction.changes);
		},
		provide(field) {
			return EditorView.decorations.from(field);
		},
	});

	// ── Update function (captures the per-instance effects) ──────────

	function dispatchCursorUpdate(
		view: EditorView,
		participants: Participant[],
		activeFile: string | undefined,
		localId: string | undefined,
	): void {
		const remoteCursors = filterRemoteCursors(participants, activeFile, localId);
		const selections = buildSelectionDecorations(remoteCursors, view);
		view.dispatch({
			effects: [setRemoteCursorsEffect.of(remoteCursors), setSelectionDecorations.of(selections)],
		});
	}

	return {
		extension: [remoteCursorsState, remoteCursorLayer, remoteSelectionsField],
		update: dispatchCursorUpdate,
	};
}
