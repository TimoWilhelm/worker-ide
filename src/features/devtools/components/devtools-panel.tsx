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

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface DevelopmentToolsPanelProperties {
	/** Ref to the preview iframe for message relay */
	previewIframeReference: React.RefObject<HTMLIFrameElement | null>;
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
function notifyDevtoolsOfNavigation(devtoolsWindow: Window, previewWindow: Window | undefined | null): void {
	const url = previewWindow ? String(previewWindow.location.href) : globalThis.location.origin;
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

// =============================================================================
// Component
// =============================================================================

export function DevelopmentToolsPanel({ previewIframeReference, className }: DevelopmentToolsPanelProperties) {
	const devtoolsIframeReference = useRef<HTMLIFrameElement>(null);
	const devtoolsReadyReference = useRef(false);

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
				if (devtoolsReadyReference.current && devtoolsWindow) {
					previewWindow?.postMessage({ event: 'LOADED' }, globalThis.location.origin);
					notifyDevtoolsOfNavigation(devtoolsWindow, previewWindow);
				}
				return;
			}

			// From preview → devtools: only forward raw CDP strings (not object messages)
			if (isFromPreview && typeof event.data === 'string') {
				devtoolsWindow?.postMessage(event.data, '*');
				return;
			}

			// From devtools → preview: wrap as { event: 'DEV', data }
			if (isFromDevtools) {
				previewWindow?.postMessage({ event: 'DEV', data: event.data }, globalThis.location.origin);
				return;
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [previewIframeReference]);

	// Mark DevTools frontend as ready once its iframe loads.
	// Also send LOADED in case the preview's __chobitsu-ready arrived first.
	const handleDevtoolsLoad = () => {
		devtoolsReadyReference.current = true;
		previewIframeReference.current?.contentWindow?.postMessage({ event: 'LOADED' }, globalThis.location.origin);
	};

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
