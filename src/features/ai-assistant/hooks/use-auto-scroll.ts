/**
 * Smart Auto-Scroll Hook
 *
 * Uses an IntersectionObserver on an invisible anchor element at the bottom
 * of the scroll container to determine whether the user is "at the bottom".
 *
 * Behavior:
 * - Auto-scrolls to bottom when new content arrives AND user is at the bottom.
 * - Stops auto-scrolling when the user scrolls up (anchor leaves viewport).
 * - Tracks `isAtBottom` internally (ref-only, no re-renders).
 * - Exposes `canScrollUp` / `canScrollDown` for fade-edge indicators.
 * - `scrollToBottom()` programmatically scrolls down and re-enables auto-scroll.
 *
 * The anchor-based approach (à la Vercel AI chatbot) is more reliable than
 * scroll-position math because it works regardless of dynamic content height
 * changes during streaming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoScrollReturn {
	/** Ref to attach to the scroll viewport element. */
	scrollReference: React.RefObject<HTMLDivElement | null>;
	/** Ref to attach to an invisible anchor div at the bottom of content. */
	anchorReference: React.RefObject<HTMLDivElement | null>;
	/** Ref to attach to the wrapper div around the scroll area + fade edges. */
	wrapperReference: React.RefObject<HTMLDivElement | null>;
	/** Whether new content arrived while the user was scrolled up. */
	hasNewContent: boolean;
	/** Smoothly scroll to the bottom and re-enable auto-scroll. */
	scrollToBottom: () => void;
	/** Reset all scroll tracking state (call after replacing message history). */
	resetScrollState: () => void;
}

/** Threshold in pixels — if within this distance of the bottom, consider "at bottom". */
const BOTTOM_THRESHOLD = 24;

export function useAutoScroll(): UseAutoScrollReturn {
	const scrollReference = useRef<HTMLDivElement>(null);
	const anchorReference = useRef<HTMLDivElement>(null);
	const wrapperReference = useRef<HTMLDivElement>(null);

	const isAtBottomReference = useRef(true);
	const [hasNewContent, setHasNewContent] = useState(false);
	const hasNewContentReference = useRef(false);

	// Track whether the user manually scrolled away. We use a ref so the
	// IntersectionObserver callback (which captures stale closures) always
	// reads the latest value.
	const userScrolledAwayReference = useRef(false);

	// Track previous scrollHeight to detect new content
	const previousScrollHeightReference = useRef(0);

	// Guard: set to true before programmatic scrolls so the scroll event
	// handler does not mistake them for user-initiated scroll-away.
	const isProgrammaticScrollReference = useRef(false);

	// ── Scroll-position tracking (for fade edges) ──────────────────────
	// Updates data attributes on the wrapper DOM element directly,
	// bypassing React state to avoid re-rendering the entire panel on
	// every scroll frame. CSS attribute selectors drive gradient opacity.
	const updateScrollEdges = useCallback(() => {
		const element = scrollReference.current;
		const wrapper = wrapperReference.current;
		if (!element || !wrapper) return;

		const { scrollTop, scrollHeight, clientHeight } = element;

		if (scrollTop > 4) {
			wrapper.dataset.canScrollUp = '';
		} else {
			delete wrapper.dataset.canScrollUp;
		}

		// When auto-scrolling (user hasn't scrolled away), content can
		// momentarily outgrow scrollTop between frames, creating a false
		// "can scroll down" signal that flickers the bottom gradient.
		// Only show the bottom fade when the user has genuinely scrolled away.
		if (userScrolledAwayReference.current && scrollTop + clientHeight < scrollHeight - 4) {
			wrapper.dataset.canScrollDown = '';
		} else {
			delete wrapper.dataset.canScrollDown;
		}
	}, []);

	// ── IntersectionObserver on the anchor ─────────────────────────────
	useEffect(() => {
		const anchor = anchorReference.current;
		const viewport = scrollReference.current;
		if (!anchor || !viewport) return;

		const observer = new IntersectionObserver(
			([entry]) => {
				if (!entry) return;
				const visible = entry.isIntersecting;
				isAtBottomReference.current = visible;

				if (visible) {
					// User scrolled back to bottom — clear "new content" flag
					userScrolledAwayReference.current = false;
					if (hasNewContentReference.current) {
						hasNewContentReference.current = false;
						setHasNewContent(false);
					}
				}
			},
			{
				root: viewport,
				// A small margin so we trigger slightly before the anchor is
				// pixel-perfectly visible (accounts for padding/gaps).
				rootMargin: `0px 0px ${BOTTOM_THRESHOLD}px 0px`,
				threshold: 0,
			},
		);

		observer.observe(anchor);
		return () => observer.disconnect();
	}, []);

	// ── Scroll event listener (for fade edges + manual scroll detection) ─
	useEffect(() => {
		const element = scrollReference.current;
		if (!element) return;

		let ticking = false;
		const handleScroll = () => {
			if (ticking) return;
			ticking = true;
			requestAnimationFrame(() => {
				ticking = false;
				updateScrollEdges();

				// Skip user-scroll-away detection for programmatic scrolls
				if (isProgrammaticScrollReference.current) {
					isProgrammaticScrollReference.current = false;
					return;
				}

				// Detect if user is near the bottom
				const { scrollTop, scrollHeight, clientHeight } = element;
				const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

				if (distanceFromBottom > BOTTOM_THRESHOLD) {
					userScrolledAwayReference.current = true;
				} else {
					userScrolledAwayReference.current = false;
					if (hasNewContentReference.current) {
						hasNewContentReference.current = false;
						setHasNewContent(false);
					}
				}
			});
		};

		element.addEventListener('scroll', handleScroll, { passive: true });
		// Initial edge calculation
		updateScrollEdges();

		return () => element.removeEventListener('scroll', handleScroll);
	}, [updateScrollEdges]);

	// ── Auto-scroll when content changes ───────────────────────────────
	// We use a MutationObserver on the scroll container to detect DOM changes
	// (new messages, streaming text, etc.) and auto-scroll if appropriate.
	useEffect(() => {
		const element = scrollReference.current;
		if (!element) return;

		// Throttle mutation handling to once per animation frame to prevent
		// layout thrashing in Chrome. The MutationObserver fires on every
		// characterData / childList change during streaming — reading
		// scrollHeight then writing scrollTop in each callback causes
		// repeated synchronous reflows. Batching into a single rAF per
		// frame eliminates the lag.
		let mutationFrameId = 0;
		const observer = new MutationObserver(() => {
			if (mutationFrameId) return;
			mutationFrameId = requestAnimationFrame(() => {
				mutationFrameId = 0;

				const { scrollHeight } = element;
				const previousHeight = previousScrollHeightReference.current;
				previousScrollHeightReference.current = scrollHeight;

				// Content grew
				if (scrollHeight > previousHeight) {
					if (userScrolledAwayReference.current) {
						// User scrolled away — flag new content
						if (!hasNewContentReference.current) {
							hasNewContentReference.current = true;
							setHasNewContent(true);
						}
					} else {
						// User is at bottom — auto-scroll regardless of streaming state.
						// This handles all cases: initial load, session restore,
						// reconnection, and live streaming.
						isProgrammaticScrollReference.current = true;
						element.scrollTop = element.scrollHeight;
					}
				}

				// Update fade edges after content change
				updateScrollEdges();
			});
		});

		observer.observe(element, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		// Capture initial scrollHeight
		previousScrollHeightReference.current = element.scrollHeight;

		return () => {
			observer.disconnect();
			cancelAnimationFrame(mutationFrameId);
		};
	}, [updateScrollEdges]);

	// ── scrollToBottom ─────────────────────────────────────────────────
	const scrollToBottom = useCallback(() => {
		const element = scrollReference.current;
		if (!element) return;

		userScrolledAwayReference.current = false;
		hasNewContentReference.current = false;
		setHasNewContent(false);
		isAtBottomReference.current = true;
		isProgrammaticScrollReference.current = true;

		element.scrollTo({
			top: element.scrollHeight,
			behavior: 'smooth',
		});
	}, []);

	// ── resetScrollState ─────────────────────────────────────────────
	// Call after replacing message history (reconnect, session load) so
	// auto-scroll resumes cleanly from the new content.
	const resetScrollState = useCallback(() => {
		userScrolledAwayReference.current = false;
		hasNewContentReference.current = false;
		setHasNewContent(false);
		isAtBottomReference.current = true;
		isProgrammaticScrollReference.current = true;
		previousScrollHeightReference.current = 0;
	}, []);

	return {
		scrollReference,
		anchorReference,
		wrapperReference,
		hasNewContent,
		scrollToBottom,
		resetScrollState,
	};
}
