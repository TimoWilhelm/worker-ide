/**
 * Preview Panel Component
 *
 * Displays the live preview of the project in an iframe.
 * Simple responsive preview without device emulation.
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
	/** Project ID for constructing preview URL */
	projectId: string;
	/** Shared iframe ref for CDP message relay with DevTools */
	iframeReference: React.RefObject<HTMLIFrameElement | null>;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Preview panel component showing live preview of the project.
 */
export function PreviewPanel({ projectId, iframeReference, className }: PreviewPanelProperties) {
	const [isLoading, setIsLoading] = useState(true);
	const [previewKey, setPreviewKey] = useState(0);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const toggleDevtools = useStore((state) => state.toggleDevtools);

	// Preview URL — must match the worker route at /p/:projectId/preview/
	const previewUrl = `/p/${projectId}/preview/`;

	// Handle iframe load
	const handleLoad = useCallback(() => {
		setIsLoading(false);
	}, []);

	// Refresh preview
	const handleRefresh = useCallback(() => {
		setIsLoading(true);
		setPreviewKey((previous) => previous + 1);
		globalThis.dispatchEvent(new CustomEvent('preview-refresh'));
	}, []);

	// Open in new tab
	const handleOpenExternal = useCallback(() => {
		window.open(previewUrl, '_blank');
	}, [previewUrl]);

	// The preview iframe has its own HMR WebSocket client (injected by
	// processHTML) that handles full-reload and CSS hot-swap internally.
	// Chobitsu (CDP implementation) is also injected for DevTools support.

	// Sync the global ref with the prop-based ref so the WebSocket handler can access the iframe
	useEffect(() => {
		previewIframeReference.current = iframeReference.current ?? undefined;
		return () => {
			previewIframeReference.current = undefined;
		};
	});

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Toolbar */}
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex items-center gap-1.5">
					<span className="text-xs font-medium text-text-secondary">Preview</span>
				</div>

				<div className="flex items-center gap-1">
					<Tooltip content="Toggle DevTools">
						<Button variant="ghost" size="icon" className={cn('size-7', devtoolsVisible && 'text-accent')} onClick={toggleDevtools}>
							<Wrench className="size-3.5" />
						</Button>
					</Tooltip>
					<Tooltip content="Refresh">
						<Button variant="ghost" size="icon" className="size-7" onClick={handleRefresh}>
							<RefreshCw className={cn('size-3.5', isLoading && 'animate-spin')} />
						</Button>
					</Tooltip>
					<Tooltip content="Open in new tab">
						<Button variant="ghost" size="icon" className="size-7" onClick={handleOpenExternal}>
							<ExternalLink className="size-3.5" />
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Preview area */}
			<div className="relative flex-1 overflow-hidden">
				{/* Loading overlay */}
				{isLoading && (
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

				{/* Iframe - full responsive, no device emulation */}
				<iframe
					key={previewKey}
					ref={iframeReference}
					src={previewUrl}
					onLoad={handleLoad}
					data-preview
					className={cn('size-full border-0', isLoading ? 'invisible' : 'visible')}
					sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
					title="Project Preview"
				/>
			</div>
		</div>
	);
}
