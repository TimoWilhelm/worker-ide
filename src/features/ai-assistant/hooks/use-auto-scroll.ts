/**
 * Smart Auto-Scroll Hook
 *
 * Uses an IntersectionObserver on an invisible anchor element at the bottom
 * of the scroll container to determine whether the user is "at the bottom".
 *
 * Behavior:
 * - Auto-scrolls to bottom when new content arrives AND user is at the bottom.
 * - Stops auto-scrolling when the user scrolls up (anchor leaves viewport).
 * - Exposes `isAtBottom` so the UI can show a "new content" pill.
 * - Exposes `canScrollUp` / `canScrollDown` for fade-edge indicators.
 * - `scrollToBottom()` programmatically scrolls down and re-enables auto-scroll.
 *
 * The anchor-based approach (à la Vercel AI chatbot) is more reliable than
 * scroll-position math because it works regardless of dynamic content height
 * changes during streaming.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

interface UseAutoScrollOptions {
	/**
	 * Whether auto-scroll should be active (e.g. when streaming).
	 * When false, the hook still tracks position but won't force-scroll.
	 */
	enabled?: boolean;
}

interface UseAutoScrollReturn {
	/** Ref to attach to the scroll viewport element. */
	scrollReference: React.RefObject<HTMLDivElement | null>;
	/** Ref to attach to an invisible anchor div at the bottom of content. */
	anchorReference: React.RefObject<HTMLDivElement | null>;
	/** Whether the bottom anchor is currently visible (user is at bottom). */
	isAtBottom: boolean;
	/** Whether there is content above the visible area. */
	canScrollUp: boolean;
	/** Whether there is content below the visible area (user scrolled up). */
	canScrollDown: boolean;
	/** Whether new content arrived while the user was scrolled up. */
	hasNewContent: boolean;
	/** Smoothly scroll to the bottom and re-enable auto-scroll. */
	scrollToBottom: () => void;
}

/** Threshold in pixels — if within this distance of the bottom, consider "at bottom". */
const BOTTOM_THRESHOLD = 24;

export function useAutoScroll({ enabled = true }: UseAutoScrollOptions = {}): UseAutoScrollReturn {
	const scrollReference = useRef<HTMLDivElement>(null);
	const anchorReference = useRef<HTMLDivElement>(null);

	const [isAtBottom, setIsAtBottom] = useState(true);
	const [canScrollUp, setCanScrollUp] = useState(false);
	const [canScrollDown, setCanScrollDown] = useState(false);
	const [hasNewContent, setHasNewContent] = useState(false);

	// Track whether the user manually scrolled away. We use a ref so the
	// IntersectionObserver callback (which captures stale closures) always
	// reads the latest value.
	const userScrolledAwayReference = useRef(false);

	// Track previous scrollHeight to detect new content
	const previousScrollHeightReference = useRef(0);

	// ── Scroll-position tracking (for fade edges) ──────────────────────
	const updateScrollEdges = useCallback(() => {
		const element = scrollReference.current;
		if (!element) return;

		const { scrollTop, scrollHeight, clientHeight } = element;
		setCanScrollUp(scrollTop > 4);
		setCanScrollDown(scrollTop + clientHeight < scrollHeight - 4);
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
				setIsAtBottom(visible);

				if (visible) {
					// User scrolled back to bottom — clear "new content" flag
					userScrolledAwayReference.current = false;
					setHasNewContent(false);
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

				// Detect if user is near the bottom
				const { scrollTop, scrollHeight, clientHeight } = element;
				const distanceFromBottom = scrollHeight - scrollTop - clientHeight;

				if (distanceFromBottom > BOTTOM_THRESHOLD) {
					userScrolledAwayReference.current = true;
				} else {
					userScrolledAwayReference.current = false;
					setHasNewContent(false);
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

		const observer = new MutationObserver(() => {
			const { scrollHeight } = element;
			const previousHeight = previousScrollHeightReference.current;
			previousScrollHeightReference.current = scrollHeight;

			// Content grew
			if (scrollHeight > previousHeight) {
				if (enabled && !userScrolledAwayReference.current) {
					// User is at bottom — auto-scroll
					element.scrollTop = element.scrollHeight;
				} else if (userScrolledAwayReference.current) {
					// User scrolled away — flag new content
					setHasNewContent(true);
				}
			}

			// Update fade edges after content change
			updateScrollEdges();
		});

		observer.observe(element, {
			childList: true,
			subtree: true,
			characterData: true,
		});

		// Capture initial scrollHeight
		previousScrollHeightReference.current = element.scrollHeight;

		return () => observer.disconnect();
	}, [enabled, updateScrollEdges]);

	// ── scrollToBottom ─────────────────────────────────────────────────
	const scrollToBottom = useCallback(() => {
		const element = scrollReference.current;
		if (!element) return;

		userScrolledAwayReference.current = false;
		setHasNewContent(false);
		setIsAtBottom(true);

		element.scrollTo({
			top: element.scrollHeight,
			behavior: 'smooth',
		});
	}, []);

	return {
		scrollReference,
		anchorReference,
		isAtBottom,
		canScrollUp,
		canScrollDown,
		hasNewContent,
		scrollToBottom,
	};
}
