import { useCallback, useEffect, useImperativeHandle, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { clearPreviewElementHighlight, highlightPreviewElement } from '@/features/preview/preview-iframe-reference';
import {
	deserializePreviewElementReference,
	getPreviewElementLabel,
	serializePreviewElementReference,
} from '@/lib/preview-element-reference';
import { cn } from '@/lib/utils';
import { getPreviewElementDisplayText, getPreviewElementReferenceKey } from '@shared/preview-element';

import { segmentsToPlainText, type InputSegment } from '../lib/input-segments';

import type { PreviewElementReference } from '@shared/types';

export interface RichTextInputHandle {
	focus: () => void;
	moveCursorToEnd: () => void;
	insertMention: (path: string, triggerOffset: number, queryLength: number) => void;
	getPlainText: () => string;
	clear: () => void;
}

const PILL_ATTR = 'data-mention-path';
const PREVIEW_ELEMENT_REFERENCE_ATTR = 'data-preview-element-reference';

function getFileName(path: string): string {
	return path.split('/').pop() ?? path;
}
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
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					segments.push({ type: 'mention', path: mentionPath });
				} else if (previewElementReference) {
					segments.push({ type: 'preview-element', ...previewElementReference });
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

function getSegmentTextLength(segment: InputSegment): number {
	return segmentsToPlainText([segment]).length;
}

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
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					offset += getSegmentTextLength({ type: 'mention', path: mentionPath });
				} else if (previewElementReference) {
					offset += getSegmentTextLength({ type: 'preview-element', ...previewElementReference });
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
				const previewElementReference = deserializePreviewElementReference(element.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
				if (mentionPath) {
					const mentionLength = getSegmentTextLength({ type: 'mention', path: mentionPath });
					if (accumulated + mentionLength >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += mentionLength;
				} else if (previewElementReference) {
					const previewElementLength = getSegmentTextLength({ type: 'preview-element', ...previewElementReference });
					if (accumulated + previewElementLength >= targetOffset) {
						const index = [...container.childNodes].indexOf(child);
						return { node: container, offset: index + 1 };
					}
					accumulated += previewElementLength;
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

function createPreviewElementPillElement(reference: PreviewElementReference): HTMLSpanElement {
	const pill = document.createElement('span');
	pill.setAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR, serializePreviewElementReference(reference));
	pill.setAttribute('aria-label', getPreviewElementDisplayText(reference));
	pill.contentEditable = 'false';
	pill.className = [
		'inline-flex items-center gap-1 rounded-full px-2 py-0.5 mx-0.5',
		'bg-linear-to-r from-rose-50 via-amber-50 to-sky-50 text-[11px] font-semibold text-slate-900',
		'dark:from-fuchsia-950 dark:via-violet-950 dark:to-sky-950 dark:text-slate-50',
		'align-baseline cursor-default select-none',
		'border border-fuchsia-200 dark:border-fuchsia-950 shadow-[0_0_0_1px_rgba(255,255,255,0.03)]',
	].join(' ');

	const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	icon.setAttribute('width', '10');
	icon.setAttribute('height', '10');
	icon.setAttribute('viewBox', '0 0 24 24');
	icon.setAttribute('fill', 'none');
	icon.setAttribute('stroke', 'currentColor');
	icon.setAttribute('stroke-width', '2');
	icon.setAttribute('stroke-linecap', 'round');
	icon.setAttribute('stroke-linejoin', 'round');
	icon.setAttribute('class', 'shrink-0 text-fuchsia-700 dark:text-fuchsia-300');
	const pathOne = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathOne.setAttribute(
		'd',
		'm21.64 3.64-1.28-1.28a1.21 1.21 0 0 0-1.72 0L2.36 18.64a1.21 1.21 0 0 0 0 1.72l1.28 1.28a1.2 1.2 0 0 0 1.72 0L21.64 5.36a1.2 1.2 0 0 0 0-1.72',
	);
	const pathTwo = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathTwo.setAttribute('d', 'm14 7 3 3');
	const pathThree = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathThree.setAttribute('d', 'M5 6v4');
	const pathFour = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathFour.setAttribute('d', 'M19 14v4');
	const pathFive = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathFive.setAttribute('d', 'M10 2v2');
	const pathSix = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathSix.setAttribute('d', 'M7 8H3');
	const pathSeven = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathSeven.setAttribute('d', 'M21 16h-4');
	const pathEight = document.createElementNS('http://www.w3.org/2000/svg', 'path');
	pathEight.setAttribute('d', 'M11 3H9');
	icon.append(pathOne, pathTwo, pathThree, pathFour, pathFive, pathSix, pathSeven, pathEight);

	const label = document.createElement('span');
	label.textContent = getPreviewElementLabel(reference.tagName);
	label.className = 'whitespace-nowrap font-mono';

	pill.append(icon, label);

	return pill;
}

export function RichTextInput({
	ref,
	segments,
	onSegmentsChange,
	onKeyDown,
	onCursorChange,
	placeholder,
	disabled,
	inlineSuffix,
	className,
}: {
	ref?: React.Ref<RichTextInputHandle>;
	segments: InputSegment[];
	onSegmentsChange: (segments: InputSegment[]) => void;
	onKeyDown?: (event: React.KeyboardEvent<HTMLDivElement>) => void;
	onCursorChange?: (offset: number) => void;
	placeholder?: string;
	disabled?: boolean;
	inlineSuffix?: React.ReactNode;
	className?: string;
}) {
	const containerReference = useRef<HTMLDivElement>(null);
	const isComposingReference = useRef(false);
	const suppressInputReference = useRef(false);
	const lastRenderedSegmentsReference = useRef<InputSegment[]>([]);
	const hoveredPreviewElementKeyReference = useRef<string | undefined>(undefined);

	// Persistent DOM node used as a portal target for inlineSuffix.
	// Created once via lazy useState initializer and re-appended after
	// each renderSegments call (since textContent='' removes it from the tree).
	const [suffixAnchor] = useState(() => {
		const span = document.createElement('span');
		span.contentEditable = 'false';
		span.style.userSelect = 'none';
		span.className = 'inline-flex items-end align-baseline';
		return span;
	});

	// Stable refs for callbacks used in insertMention
	const onSegmentsChangeReference = useRef(onSegmentsChange);
	const onCursorChangeReference = useRef(onCursorChange);
	useEffect(() => {
		onSegmentsChangeReference.current = onSegmentsChange;
		onCursorChangeReference.current = onCursorChange;
	}, [onSegmentsChange, onCursorChange]);

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
			} else if (segment.type === 'mention') {
				container.append(createPillElement(segment.path));
			} else {
				container.append(createPreviewElementPillElement(segment));
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

		// Append inline suffix anchor at the end of content
		if (inlineSuffix) {
			container.append(suffixAnchor);
			// Auto-scroll to keep the latest content visible
			container.scrollTop = container.scrollHeight;
		}

		suppressInputReference.current = false;
	}, [segments, inlineSuffix, suffixAnchor]);

	// Expose imperative handle
	useImperativeHandle(ref, () => ({
		focus() {
			containerReference.current?.focus();
		},
		moveCursorToEnd() {
			const container = containerReference.current;
			if (!container) return;
			const selection = globalThis.getSelection();
			if (!selection) return;
			const range = document.createRange();
			range.selectNodeContents(container);
			range.collapse(false);
			selection.removeAllRanges();
			selection.addRange(range);
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
					} else if (segment.type === 'mention') {
						liveContainer.append(createPillElement(segment.path));
					} else {
						liveContainer.append(createPreviewElementPillElement(segment));
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

	const handleMouseMove = useCallback((event: React.MouseEvent<HTMLDivElement>) => {
		const target =
			event.target instanceof HTMLElement ? event.target.closest<HTMLElement>(`[${PREVIEW_ELEMENT_REFERENCE_ATTR}]`) : undefined;
		const reference = deserializePreviewElementReference(target?.getAttribute(PREVIEW_ELEMENT_REFERENCE_ATTR) ?? '');
		const referenceKey = reference ? getPreviewElementReferenceKey(reference) : undefined;

		if (referenceKey === hoveredPreviewElementKeyReference.current) {
			return;
		}

		hoveredPreviewElementKeyReference.current = referenceKey;
		if (!reference) {
			clearPreviewElementHighlight();
			return;
		}

		highlightPreviewElement(reference);
	}, []);

	const handleMouseLeave = useCallback(() => {
		hoveredPreviewElementKeyReference.current = undefined;
		clearPreviewElementHighlight();
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
				onMouseMove={handleMouseMove}
				onMouseLeave={handleMouseLeave}
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
			{inlineSuffix && createPortal(inlineSuffix, suffixAnchor)}
		</div>
	);
}
