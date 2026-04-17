import { useCallback, useState, useSyncExternalStore } from 'react';

import { useIsMobile } from './use-is-mobile';

import type { CSSProperties, RefCallback } from 'react';

/**
 * Minimum height difference (in px) between `window.innerHeight` and
 * `visualViewport.height` to consider the keyboard "open". Mobile browser
 * chrome (address bar) typically changes the height by ~50–70 px.
 */
const KEYBOARD_THRESHOLD_PX = 100;

// ---------------------------------------------------------------------------
// External store — derives keyboard-aware height from the VisualViewport API
// ---------------------------------------------------------------------------

function subscribe(callback: () => void): () => void {
	const viewport = globalThis.visualViewport;
	if (!viewport) {
		return () => {};
	}

	viewport.addEventListener('resize', callback);
	viewport.addEventListener('scroll', callback);
	globalThis.addEventListener('orientationchange', callback);

	return () => {
		viewport.removeEventListener('resize', callback);
		viewport.removeEventListener('scroll', callback);
		globalThis.removeEventListener('orientationchange', callback);
	};
}
function getSnapshot(): number | undefined {
	const viewport = globalThis.visualViewport;
	if (!viewport) {
		return undefined;
	}

	const viewportHeight = viewport.height;
	const windowHeight = globalThis.innerHeight;

	if (windowHeight - viewportHeight < KEYBOARD_THRESHOLD_PX) {
		return undefined;
	}

	if (viewportHeight < 200 || viewportHeight >= windowHeight) {
		return undefined;
	}

	return viewportHeight;
}

function getServerSnapshot(): undefined {
	return undefined;
}

// ---------------------------------------------------------------------------
// Style cache — keep referential identity to avoid re-renders
// ---------------------------------------------------------------------------

let cachedHeight = 0;
let cachedTop = 0;
let cachedLeft = 0;
let cachedWidth = 0;
let cachedStyle: CSSProperties | undefined;

function fixedStyleFor(top: number, left: number, width: number, height: number): CSSProperties {
	if (cachedStyle && height === cachedHeight && top === cachedTop && left === cachedLeft && width === cachedWidth) {
		return cachedStyle;
	}
	cachedHeight = height;
	cachedTop = top;
	cachedLeft = left;
	cachedWidth = width;
	cachedStyle = {
		position: 'fixed',
		top,
		left,
		width,
		height,
		zIndex: 40,
	};
	return cachedStyle;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

interface ElementRect {
	top: number;
	left: number;
	width: number;
}

const INITIAL_RECT: ElementRect = { top: 0, left: 0, width: 0 };

export interface MobileKeyboardLayout {
	style: CSSProperties | undefined;
	/**
	 * Ref callback — attach to the container element so the hook can measure
	 * its position before it goes fixed.
	 */
	ref: RefCallback<HTMLElement>;
	isKeyboardOpen: boolean;
}

/**
 * Returns layout props to apply on a container so it stays fully visible
 * above the virtual keyboard on mobile.
 */
export function useMobileKeyboardLayout(): MobileKeyboardLayout {
	const isMobile = useIsMobile();
	const keyboardHeight = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

	// Store the element's document-flow rect in state (not a ref) so it can be
	// safely read during render without violating the refs-in-render lint rule.
	const [rect, setRect] = useState<ElementRect>(INITIAL_RECT);

	const reference: RefCallback<HTMLElement> = useCallback((node: HTMLElement | null) => {
		if (node) {
			const domRect = node.getBoundingClientRect();
			setRect((previous) => {
				if (previous.top === domRect.top && previous.left === domRect.left && previous.width === domRect.width) {
					return previous;
				}
				return { top: domRect.top, left: domRect.left, width: domRect.width };
			});
		}
	}, []);

	const isKeyboardOpen = isMobile && keyboardHeight !== undefined;

	let style: CSSProperties | undefined;

	if (isKeyboardOpen && keyboardHeight !== undefined) {
		const width = rect.width || globalThis.innerWidth;
		style = fixedStyleFor(rect.top, rect.left, width, keyboardHeight - rect.top);
	}

	return { style, ref: reference, isKeyboardOpen };
}
