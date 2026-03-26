/**
 * DevTools Panel Component
 *
 * Embeds the Chrome DevTools frontend (via chii) in an iframe.
 * Acts as a CDP message relay between the preview iframe (running chobitsu)
 * and the DevTools frontend iframe.
 *
 * Architecture:
 *   Preview iframe (chobitsu) ←→ Parent (this relay) ←→ DevTools iframe (chii)
 *
 * Message flow:
 *   chobitsu  → raw CDP string      → parent → forwards string   → chii
 *   chii     → raw CDP string       → parent → { event:'DEV' }   → chobitsu
 *   parent   → { event:'LOADED' }   → chobitsu (triggers CDP init sequence)
 */

import { useEffect, useMemo, useRef } from 'react';

import { useTheme } from '@/hooks/use-theme';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface DevelopmentToolsPanelProperties {
	/** Ref to the preview iframe for message relay */
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
	/** The preview iframe's origin for secure postMessage targeting. Undefined while the signed URL is loading. */
	previewOrigin: string | undefined;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Send navigation reset CDP events to the DevTools frontend so it
 * refreshes Elements/Console/Network after a preview reload.
 */
function notifyDevtoolsOfNavigation(devtoolsWindow: Window, previewWindow: Window | undefined | null, previewOrigin: string): void {
	let url: string;
	try {
		// Cross-origin iframes block access to location.href — fall back to the preview origin.
		url = previewWindow ? String(previewWindow.location.href) : previewOrigin;
	} catch {
		url = previewOrigin;
	}
	devtoolsWindow.postMessage(
		JSON.stringify({
			method: 'Page.frameNavigated',
			params: {
				frame: { id: '1', mimeType: 'text/html', securityOrigin: globalThis.location.origin, url },
				type: 'Navigation',
			},
		}),
		'*',
	);
	devtoolsWindow.postMessage(JSON.stringify({ method: 'Runtime.executionContextsCleared' }), '*');
	devtoolsWindow.postMessage(JSON.stringify({ method: 'DOM.documentUpdated' }), '*');
}

/**
 * Apply the resolved editor theme to the DevTools iframe.
 *
 * The chii DevTools frontend uses `prefers-color-scheme` media queries and
 * the `.-theme-with-dark-background` CSS class on `<html>` to switch themes.
 * Because the iframe is a same-origin blob URL we can manipulate its DOM
 * directly.  We:
 *   1. Set `<meta name="color-scheme">` so internal media queries resolve
 *      to the correct scheme (overrides the OS-level preference).
 *   2. Toggle the `.-theme-with-dark-background` class that the DevTools
 *      CSS hooks into for dark-mode styles.
 */
function applyThemeToDevtools(iframe: HTMLIFrameElement | null, theme: 'light' | 'dark'): void {
	const document_ = iframe?.contentDocument;
	if (!document_) return;

	const isDark = theme === 'dark';

	// 1. Ensure a <meta name="color-scheme"> exists and reflects the theme.
	let meta = document_.head.querySelector<HTMLMetaElement>('meta[name="color-scheme"]');
	if (!meta) {
		meta = document_.createElement('meta');
		meta.name = 'color-scheme';
		document_.head.append(meta);
	}
	meta.content = isDark ? 'dark' : 'light';

	// 2. Toggle the class that the DevTools frontend checks for dark mode.
	document_.documentElement.classList.toggle('-theme-with-dark-background', isDark);
}

// =============================================================================
// Component
// =============================================================================

export function DevelopmentToolsPanel({ previewIframeReference, previewOrigin, className }: DevelopmentToolsPanelProperties) {
	const devtoolsIframeReference = useRef<HTMLIFrameElement>(null);
	const devtoolsReadyReference = useRef(false);
	const resolvedTheme = useTheme();

	// Generate the DevTools frontend URL using chii's hosted build
	const devtoolsSource = useMemo(() => {
		const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>DevTools</title>
<style>
@media (prefers-color-scheme: dark) {
  body { background-color: rgb(41 42 45); }
}
</style>
<meta name="referrer" content="no-referrer">
<script src="https://unpkg.com/@ungap/custom-elements/es.js"></script>
<script type="module" src="https://cdn.jsdelivr.net/npm/chii@1/public/front_end/entrypoints/chii_app/chii_app.js"></script>
</head>
<body class="undocked" id="-blink-dev-tools">
</body>
</html>`;
		const blobUrl = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
		const origin = encodeURIComponent(globalThis.location.origin);
		return `${blobUrl}#?embedded=${origin}`;
	}, []);

	// Clean up blob URL on unmount
	useEffect(() => {
		const blobUrl = devtoolsSource.split('#')[0];
		return () => URL.revokeObjectURL(blobUrl);
	}, [devtoolsSource]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			const previewWindow = previewIframeReference.current?.contentWindow;
			const devtoolsWindow = devtoolsIframeReference.current?.contentWindow;
			const isFromPreview = event.source === previewWindow;
			const isFromDevtools = event.source === devtoolsWindow;

			// Chobitsu ready — preview (re)loaded and chobitsu initialized.
			// Send LOADED to trigger the CDP init sequence, and notify the
			// DevTools frontend that the page has navigated so it refreshes.
			if (isFromPreview && typeof event.data === 'object' && event.data?.type === '__chobitsu-ready') {
				if (devtoolsReadyReference.current && devtoolsWindow && previewOrigin) {
					previewWindow?.postMessage({ event: 'LOADED' }, previewOrigin);
					notifyDevtoolsOfNavigation(devtoolsWindow, previewWindow, previewOrigin);
				}
				return;
			}

			// From preview → devtools: only forward raw CDP strings (not object messages)
			if (isFromPreview && typeof event.data === 'string') {
				devtoolsWindow?.postMessage(event.data, '*');
				return;
			}

			// From devtools → preview: wrap as { event: 'DEV', data }
			if (isFromDevtools && previewOrigin) {
				previewWindow?.postMessage({ event: 'DEV', data: event.data }, previewOrigin);
				return;
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [previewIframeReference, previewOrigin]);

	// Mark DevTools frontend as ready once its iframe loads.
	// Also send LOADED in case the preview's __chobitsu-ready arrived first.
	const handleDevtoolsLoad = () => {
		devtoolsReadyReference.current = true;
		applyThemeToDevtools(devtoolsIframeReference.current, resolvedTheme);
		if (previewOrigin) {
			previewIframeReference.current?.contentWindow?.postMessage({ event: 'LOADED' }, previewOrigin);
		}
	};

	// Re-apply theme whenever the editor theme changes after initial load.
	useEffect(() => {
		if (devtoolsReadyReference.current) {
			applyThemeToDevtools(devtoolsIframeReference.current, resolvedTheme);
		}
	}, [resolvedTheme]);

	return (
		<div className={cn('flex h-full flex-col overflow-hidden', className)}>
			<iframe
				ref={devtoolsIframeReference}
				src={devtoolsSource}
				onLoad={handleDevtoolsLoad}
				className="size-full border-0"
				title="DevTools"
			/>
		</div>
	);
}
