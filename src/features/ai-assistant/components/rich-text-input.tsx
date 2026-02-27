/**
 * Rich Text Input
 *
 * A contentEditable-based input that supports inline file mention pills.
 * Text is editable normally; file mentions render as styled atomic spans.
 *
 * The component maintains a list of InputSegment objects as its model.
 * On every DOM mutation it re-parses the contentEditable back to segments.
 * File mention pills use data attributes and contentEditable=false, so
 * the browser treats them as atomic inline units.
 */

import { useCallback, useEffect, useImperativeHandle, useRef } from 'react';

import { cn } from '@/lib/utils';

import { segmentsToPlainText, type InputSegment } from '../lib/input-segments';

// =============================================================================
// Public handle
// =============================================================================

export interface RichTextInputHandle {
	focus: () => void;
	insertMention: (path: string, triggerOffset: number, queryLength: number) => void;
	getPlainText: () => string;
	clear: () => void;
}

// =============================================================================
// DOM helpers
// =============================================================================

const PILL_ATTR = 'data-mention-path';

function getFileName(path: string): string {
	return path.split('/').pop() ?? path;
}

/**
 * Parse the contentEditable DOM back into segments.
 */
function parseSegmentsFromDom(container: HTMLElement): InputSegment[] {
	const segments: InputSegment[] = [];

	for (const node of container.childNodes) {
		if (node.nodeType === Node.TEXT_NODE) {
			const text = node.textContent ?? '';
			if (text) {
				segments.push({ type: 'text', value: text });
			}
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node instanceof HTMLElement ? node : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				if (mentionPath) {
					segments.push({ type: 'mention', path: mentionPath });
				} else if (element.tagName === 'BR') {
					segments.push({ type: 'text', value: '\n' });
				} else {
					const text = element.textContent ?? '';
					if (text) {
						segments.push({ type: 'text', value: text });
					}
				}
			}
		}
	}

	return segments;
}

/**
 * Compute the plain-text cursor offset from the DOM selection.
 */
function getCursorOffsetInContainer(container: HTMLElement): number {
	const selection = globalThis.getSelection();
	if (!selection || selection.rangeCount === 0) return -1;

	const range = selection.getRangeAt(0);
	const preRange = document.createRange();
	preRange.setStart(container, 0);
	preRange.setEnd(range.startContainer, range.startOffset);

	const fragment = preRange.cloneContents();
	let offset = 0;

	function walk(node: Node): void {
		if (node.nodeType === Node.TEXT_NODE) {
			offset += (node.textContent ?? '').length;
		} else if (node.nodeType === Node.ELEMENT_NODE) {
			const element = node instanceof HTMLElement ? node : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				if (mentionPath) {
					offset += 1 + mentionPath.length;
				} else if (element.tagName === 'BR') {
					offset += 1;
				} else {
					for (const child of node.childNodes) {
						walk(child);
					}
				}
			}
		}
	}

	for (const child of fragment.childNodes) {
		walk(child);
	}

	return offset;
}

/**
 * Find the DOM node + offset for a given plain-text offset.
 */
function findDomPosition(container: HTMLElement, targetOffset: number): { node: Node; offset: number } | undefined {
	let accumulated = 0;

	for (const child of container.childNodes) {
		if (child.nodeType === Node.TEXT_NODE) {
			const length = (child.textContent ?? '').length;
			if (accumulated + length >= targetOffset) {
				return { node: child, offset: targetOffset - accumulated };
			}
			accumulated += length;
		} else if (child.nodeType === Node.ELEMENT_NODE) {
			const element = child instanceof HTMLElement ? child : undefined;
			if (element) {
				const mentionPath = element.getAttribute(PILL_ATTR);
				if (mentionPath) {
					const mentionLength = 1 + mentionPath.length;
					if (accumulated + mentionLength >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += mentionLength;
				} else if (element.tagName === 'BR') {
					if (accumulated + 1 >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += 1;
				} else {
					accumulated += (element.textContent ?? '').length;
				}
			}
		}
	}

	return { node: container, offset: container.childNodes.length };
}

/**
 * Build a pill DOM element for a file mention.
 */
function createPillElement(path: string): HTMLSpanElement {
	const pill = document.createElement('span');
	pill.setAttribute(PILL_ATTR, path);
	pill.contentEditable = 'false';
	pill.className = [
		'inline-flex items-center gap-1 rounded px-1.5 py-px mx-0.5',
		'bg-accent/15 text-accent text-xs font-mono',
		'align-baseline cursor-default select-none',
		'border border-accent/25',
	].join(' ');

	// File icon (inline SVG for imperative DOM)
	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('width', '10');
	icon.setAttribute('height', '10');
	icon.setAttribute('viewBox', '0 0 24 24');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('stroke', 'currentColor');
	icon.setAttribute('stroke-width', '2');
	icon.setAttribute('stroke-linecap', 'round');
	icon.setAttribute('stroke-linejoin', 'round');
	icon.setAttribute('class', 'shrink-0');
	const pathElement = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathElement.setAttribute('d', 'M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z');
	const polyline = document.createElementNS('http://www.w3.org/2000/svg', 'polyline');
	polyline.setAttribute('points', '14 2 14 8 20 8');
	icon.append(pathElement, polyline);

	const label = document.createElement('span');
	label.textContent = getFileName(path);
	label.className = 'truncate max-w-[120px]';

	pill.append(icon, label);

	return pill;
}

// =============================================================================
// Component
// =============================================================================

export function RichTextInput({
	ref,
	segments,
	onSegmentsChange,
	onKeyDown,
	onCursorChange,
	placeholder,
	disabled,
	className,
}: {
	ref?: React.Ref<RichTextInputHandle>;
	segments: InputSegment[];
	onSegmentsChange: (segments: InputSegment[]) => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onCursorChange?: (offset: number) => void;
	placeholder?: string;
	disabled?: boolean;
	className?: string;
}) {
	const containerReference = useRef<HTMLDivElement>(null);
	const isComposingReference = useRef(false);
	const suppressInputReference = useRef(false);
	const lastRenderedSegmentsReference = useRef<InputSegment[]>([]);

	// Stable refs for callbacks used in insertMention
	const onSegmentsChangeReference = useRef(onSegmentsChange);
	const onCursorChangeReference = useRef(onCursorChange);
	useEffect(() => {
		onSegmentsChangeReference.current = onSegmentsChange;
	}, [onSegmentsChange]);
	useEffect(() => {
		onCursorChangeReference.current = onCursorChange;
	}, [onCursorChange]);

	// Render segments into the DOM
	const renderSegments = useCallback(() => {
		const container = containerReference.current;
		if (!container) return;

		const cursorOffset = getCursorOffsetInContainer(container);

		suppressInputReference.current = true;
		container.textContent = '';

		for (const segment of segments) {
			if (segment.type === 'text') {
				const parts = segment.value.split('\n');
				for (const [index, part] of parts.entries()) {
					if (index > 0) {
						container.append(document.createElement('br'));
					}
					if (part) {
						container.append(document.createTextNode(part));
					}
				}
			} else {
				container.append(createPillElement(segment.path));
			}
		}

		// Restore cursor
		if (cursorOffset >= 0) {
			const position = findDomPosition(container, cursorOffset);
			if (position) {
				const selection = globalThis.getSelection();
				if (selection) {
					const range = document.createRange();
					range.setStart(position.node, position.offset);
					range.collapse(true);
					selection.removeAllRanges();
					selection.addRange(range);
				}
			}
		}

		suppressInputReference.current = false;
	}, [segments]);

	// Expose imperative handle
	useImperativeHandle(ref, () => ({
		focus() {
			containerReference.current?.focus();
		},
		insertMention(path: string, triggerOffset: number, queryLength: number) {
			const container = containerReference.current;
			if (!container) return;

			const plainText = segmentsToPlainText(parseSegmentsFromDom(container));
			const before = plainText.slice(0, triggerOffset);
			const after = plainText.slice(triggerOffset + 1 + queryLength);

			const newSegments: InputSegment[] = [];
			if (before) {
				newSegments.push({ type: 'text', value: before });
			}
			newSegments.push({ type: 'mention', path }, { type: 'text', value: ` ${after}` });

			lastRenderedSegmentsReference.current = newSegments;
			onSegmentsChangeReference.current(newSegments);

			requestAnimationFrame(() => {
				const liveContainer = containerReference.current;
				if (!liveContainer) return;

				// Rebuild DOM
				suppressInputReference.current = true;
				liveContainer.textContent = '';
				for (const segment of newSegments) {
					if (segment.type === 'text') {
						const parts = segment.value.split('\n');
						for (const [index, part] of parts.entries()) {
							if (index > 0) {
								liveContainer.append(document.createElement('br'));
							}
							if (part) {
								liveContainer.append(document.createTextNode(part));
							}
						}
					} else {
						liveContainer.append(createPillElement(segment.path));
					}
				}
				suppressInputReference.current = false;

				// Place cursor after the pill + space
				const newOffset = before.length + 1 + path.length + 1;
				const position = findDomPosition(liveContainer, newOffset);
				if (position) {
					const selection = globalThis.getSelection();
					if (selection) {
						const range = document.createRange();
						range.setStart(position.node, position.offset);
						range.collapse(true);
						selection.removeAllRanges();
						selection.addRange(range);
					}
				}
				liveContainer.focus();

				onCursorChangeReference.current?.(newOffset);
			});
		},
		getPlainText() {
			return segmentsToPlainText(segments);
		},
		clear() {
			const container = containerReference.current;
			if (container) {
				container.textContent = '';
			}
			onSegmentsChangeReference.current([]);
		},
	}));

	// Re-render DOM when segments identity changes
	useEffect(() => {
		if (lastRenderedSegmentsReference.current !== segments) {
			lastRenderedSegmentsReference.current = segments;
			renderSegments();
		}
	}, [segments, renderSegments]);

	// Handle input events — re-parse DOM into segments
	const handleInput = useCallback(() => {
		if (suppressInputReference.current || isComposingReference.current) return;
		const container = containerReference.current;
		if (!container) return;

		const newSegments = parseSegmentsFromDom(container);
		lastRenderedSegmentsReference.current = newSegments;
		onSegmentsChange(newSegments);

		if (onCursorChange) {
			const offset = getCursorOffsetInContainer(container);
			onCursorChange(offset);
		}
	}, [onSegmentsChange, onCursorChange]);

	// Track cursor on selection changes
	const handleSelect = useCallback(() => {
		if (!onCursorChange) return;
		const container = containerReference.current;
		if (!container) return;
		const offset = getCursorOffsetInContainer(container);
		if (offset >= 0) {
			onCursorChange(offset);
		}
	}, [onCursorChange]);

	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent<HTMLDivElement>) => {
			onKeyDown?.(event);
		},
		[onKeyDown],
	);

	const handlePaste = useCallback((event: React.ClipboardEvent<HTMLDivElement>) => {
		event.preventDefault();
		const text = event.clipboardData.getData('text/plain');
		if (text) {
			document.execCommand('insertText', false, text);
		}
	}, []);

	const isEmpty = segments.length === 0 || (segments.length === 1 && segments[0].type === 'text' && !segments[0].value);

	return (
		<div className="relative">
			{isEmpty && !disabled && (
				<div
					className="
						pointer-events-none absolute inset-0 truncate px-2.5 pt-2 text-sm/relaxed
						text-text-secondary
					"
				>
					{placeholder}
				</div>
			)}
			<div
				ref={containerReference}
				contentEditable={!disabled}
				suppressContentEditableWarning
				onInput={handleInput}
				onKeyDown={handleKeyDown}
				onSelect={handleSelect}
				onClick={handleSelect}
				onCompositionStart={() => {
					isComposingReference.current = true;
				}}
				onCompositionEnd={() => {
					isComposingReference.current = false;
					handleInput();
				}}
				onPaste={handlePaste}
				role="textbox"
				aria-multiline="true"
				aria-placeholder={placeholder}
				className={cn(
					`
						block max-h-32 min-h-[3em] w-full overflow-y-auto bg-transparent px-2.5
						pt-2 pb-0
					`,
					'text-sm/relaxed text-text-primary',
					`
						focus:outline-none
						focus-visible:outline-none
					`,
					disabled && 'pointer-events-none opacity-50',
					className,
				)}
			/>
		</div>
	);
}
