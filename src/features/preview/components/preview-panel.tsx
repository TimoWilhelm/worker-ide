/**
 * Preview Panel Component
 *
 * Displays the live preview in a cross-origin iframe on a preview subdomain.
 * The preview URL includes an HMAC-signed time-bucket token that expires
 * after 1–2 hours. When the token expires, the parent component detects
 * the 403 and refreshes the URL.
 */

import { ExternalLink, RefreshCw, Wrench } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { previewIframeReference } from '@/features/preview/preview-iframe-reference';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface PreviewPanelProperties {
	/** Signed preview URL with trailing slash. */
	previewUrl: string | undefined;
	/** Whether the signed URL is still being fetched. */
	isLoadingUrl: boolean;
	/** Refresh the signed preview URL (e.g., after token expiry). */
	refreshPreviewUrl: () => Promise<void>;
	/** Shared iframe ref for CDP message relay with DevTools */
	iframeReference: React.RefObject<HTMLIFrameElement | null>;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

export function PreviewPanel({ previewUrl, isLoadingUrl, refreshPreviewUrl, iframeReference, className }: PreviewPanelProperties) {
	const [isLoading, setIsLoading] = useState(true);
	const [previewKey, setPreviewKey] = useState(0);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const toggleDevtools = useStore((state) => state.toggleDevtools);

	const handleLoad = useCallback(() => {
		setIsLoading(false);
	}, []);

	const handleRefresh = useCallback(() => {
		setIsLoading(true);
		setPreviewKey((previous) => previous + 1);
		globalThis.dispatchEvent(new CustomEvent('preview-refresh'));
	}, []);

	const handleOpenExternal = useCallback(() => {
		if (previewUrl) {
			window.open(previewUrl, '_blank');
		}
	}, [previewUrl]);

	useEffect(() => {
		const FORCE_REFRESH_DELAY_MS = 500;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const handleForceRefresh = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				handleRefresh();
			}, FORCE_REFRESH_DELAY_MS);
		};

		globalThis.addEventListener('preview-force-refresh', handleForceRefresh);
		return () => {
			globalThis.removeEventListener('preview-force-refresh', handleForceRefresh);
			if (timer) clearTimeout(timer);
		};
	}, [handleRefresh]);

	// Detect token expiry via postMessage from the preview iframe.
	//
	// When the HMAC token is invalid the Worker returns a 403 HTML page that
	// posts `{ type: '__preview-expired' }` to window.parent. We listen here
	// and silently fetch a fresh signed URL so the iframe reloads automatically.
	//
	// This replaces a document.title check, which fails because the 403 page
	// is served on the (expired) preview subdomain — a different origin from
	// the IDE app — so cross-origin DOM access is blocked by the browser.
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.source !== iframeReference.current?.contentWindow) return;
			if (typeof event.data === 'object' && event.data !== null && event.data.type === '__preview-expired') {
				void refreshPreviewUrl();
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [iframeReference, refreshPreviewUrl]);

	useEffect(() => {
		previewIframeReference.current = iframeReference.current ?? undefined;
		return () => {
			previewIframeReference.current = undefined;
		};
	});

	const showLoadingOverlay = isLoading || isLoadingUrl;

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Toolbar */}
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="truncate text-xs font-medium text-text-secondary">Preview</span>
				</div>

				<div className="flex shrink-0 items-center gap-1">
					<Tooltip content="Toggle DevTools">
						<Button variant="ghost" size="icon" className={cn('size-7', devtoolsVisible && 'text-accent')} onClick={toggleDevtools}>
							<Wrench className="size-3.5" />
						</Button>
					</Tooltip>
					<Tooltip content="Refresh">
						<Button variant="ghost" size="icon" className="size-7" onClick={handleRefresh}>
							<RefreshCw className={cn('size-3.5', showLoadingOverlay && 'animate-spin')} />
						</Button>
					</Tooltip>
					<Tooltip content="Open in new tab">
						<Button variant="ghost" size="icon" className="size-7" onClick={handleOpenExternal} disabled={!previewUrl}>
							<ExternalLink className="size-3.5" />
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Preview area */}
			<div className="relative flex-1 overflow-hidden">
				{showLoadingOverlay && (
					<div
						className="
							absolute inset-0 z-10 flex items-center justify-center bg-bg-tertiary/80
						"
					>
						<div className="flex flex-col items-center gap-2">
							<RefreshCw className="size-6 animate-spin text-accent" />
							<span className="text-sm text-text-secondary">Loading preview...</span>
						</div>
					</div>
				)}

				{/* Cross-origin iframe — preview runs on its own subdomain with signed URL */}
				{previewUrl && (
					<iframe
						key={previewKey}
						ref={iframeReference}
						src={previewUrl}
						onLoad={handleLoad}
						data-preview
						className={cn('size-full border-0', showLoadingOverlay ? 'invisible' : 'visible')}
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
						title="Project Preview"
					/>
				)}
			</div>
		</div>
	);
}
