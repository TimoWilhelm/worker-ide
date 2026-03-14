/**
 * Preview Panel Component
 *
 * Displays the live preview in a cross-origin iframe on a preview subdomain.
 */

import { ExternalLink, RefreshCw, Wrench } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { previewIframeReference } from '@/features/preview/preview-iframe-reference';
import { getPreviewUrl } from '@/lib/preview-origin';
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

export function PreviewPanel({ projectId, iframeReference, className }: PreviewPanelProperties) {
	const [isLoading, setIsLoading] = useState(true);
	const [previewKey, setPreviewKey] = useState(0);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const toggleDevtools = useStore((state) => state.toggleDevtools);

	const previewUrl = useMemo(() => getPreviewUrl(projectId), [projectId]);

	const handleLoad = useCallback(() => {
		setIsLoading(false);
	}, []);

	const handleRefresh = useCallback(() => {
		setIsLoading(true);
		setPreviewKey((previous) => previous + 1);
		globalThis.dispatchEvent(new CustomEvent('preview-refresh'));
	}, []);

	const handleOpenExternal = useCallback(() => {
		window.open(previewUrl, '_blank');
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

				{/* Cross-origin iframe — preview runs on its own subdomain */}
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
