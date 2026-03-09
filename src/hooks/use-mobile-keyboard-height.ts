/**
 * Mobile Keyboard-Aware Height Hook
 *
 * Uses the VisualViewport API to detect when the virtual keyboard is open on mobile
 * and returns inline styles that resize the consuming container to the visible area
 * above the keyboard, keeping all flex children (header, input) on screen.
 *
 * Uses `useSyncExternalStore` to subscribe to visual-viewport resize events,
 * avoiding synchronous setState inside effects.
 *
 * Edge cases handled:
 * - VisualViewport API not available → returns undefined (no-op)
 * - Not on mobile → returns undefined (no-op)
 * - Address bar hide/show → uses a threshold to distinguish from real keyboard
 * - Orientation changes → recalculates
 * - Browser page-scroll on focus → counteracted via scrollTo(0,0)
 */

import { useSyncExternalStore } from 'react';

import { useIsMobile } from './use-is-mobile';

import type { CSSProperties } from 'react';

/**
 * Minimum height difference (in px) between window.innerHeight and
 * visualViewport.height to consider the keyboard "open". This avoids
 * false positives from mobile browser chrome (address bar) showing/hiding,
 * which typically changes the viewport by ~50–70 px.
 */
const KEYBOARD_THRESHOLD_PX = 100;

// ---------------------------------------------------------------------------
// Shared subscription for the VisualViewport external store
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

function getSnapshot(): CSSProperties | undefined {
	const viewport = globalThis.visualViewport;
	if (!viewport) {
		return undefined;
	}

	const viewportHeight = viewport.height;
	const windowHeight = globalThis.innerHeight;
	const heightDifference = windowHeight - viewportHeight;

	if (heightDifference < KEYBOARD_THRESHOLD_PX) {
		return undefined;
	}

	// Keyboard is open — reset any browser-initiated page scroll so the
	// container stays at the top of the visible area.
	if (globalThis.scrollY !== 0) {
		globalThis.scrollTo(0, 0);
	}

	// Sanity: don't apply if the height would be unusably small
	if (viewportHeight < 200 || viewportHeight >= windowHeight) {
		return undefined;
	}

	return keyboardStyleForHeight(viewportHeight);
}

function getServerSnapshot(): undefined {
	return undefined;
}

// Cache the last returned object to keep referential identity when the value
// hasn't changed, preventing unnecessary re-renders.
let cachedHeight = 0;
let cachedStyle: CSSProperties | undefined;

function keyboardStyleForHeight(height: number): CSSProperties {
	if (height === cachedHeight && cachedStyle) {
		return cachedStyle;
	}
	cachedHeight = height;
	cachedStyle = { height };
	return cachedStyle;
}

/**
 * Returns a `CSSProperties` object to apply on the panel container when the
 * virtual keyboard is open on mobile. Returns `undefined` when the keyboard
 * is closed or on desktop — callers should use their default sizing.
 */
export function useMobileKeyboardStyle(): CSSProperties | undefined {
	const isMobile = useIsMobile();

	const style = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

	// On desktop the hook is a no-op regardless of what the store says.
	if (!isMobile) {
		return undefined;
	}

	return style;
}
