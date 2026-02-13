/**
 * Preview Panel Component
 *
 * Displays the live preview of the project in an iframe.
 * Simple responsive preview without device emulation.
 */

import { ExternalLink, RefreshCw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface PreviewPanelProperties {
	/** Project ID for constructing preview URL */
	projectId: string;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Component
// =============================================================================

/**
 * Preview panel component showing live preview of the project.
 */
export function PreviewPanel({ projectId, className }: PreviewPanelProperties) {
	const iframeReference = useRef<HTMLIFrameElement>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [previewKey, setPreviewKey] = useState(0);

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
	}, []);

	// Open in new tab
	const handleOpenExternal = useCallback(() => {
		window.open(previewUrl, '_blank');
	}, [previewUrl]);

	// Listen for HMR reload messages
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.data?.type === 'hmr:reload') {
				handleRefresh();
			}
		};

		window.addEventListener('message', handleMessage);
		return () => window.removeEventListener('message', handleMessage);
	}, [handleRefresh]);

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
					<span
						className="
							rounded-sm bg-bg-tertiary px-1.5 py-0.5 font-mono text-xs
							text-text-secondary
						"
					>
						/preview
					</span>
				</div>

				<div className="flex items-center gap-1">
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
