/**
 * Preview Panel Component
 *
 * Displays the live preview of the project in an iframe.
 * Supports HMR updates and responsive device emulation.
 */

import { ExternalLink, Maximize2, Monitor, RefreshCw, Smartphone, Tablet } from 'lucide-react';
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

type DeviceMode = 'responsive' | 'mobile' | 'tablet' | 'desktop';

interface DevicePreset {
	width: number;
	height: number;
	label: string;
}

const DEVICE_PRESETS: Record<Exclude<DeviceMode, 'responsive'>, DevicePreset> = {
	mobile: { width: 375, height: 667, label: 'Mobile' },
	tablet: { width: 768, height: 1024, label: 'Tablet' },
	desktop: { width: 1280, height: 800, label: 'Desktop' },
};

// =============================================================================
// Helpers
// =============================================================================

function getIframeDimensions(deviceMode: DeviceMode) {
	if (deviceMode === 'responsive') {
		return { width: '100%', height: '100%' };
	}
	const preset = DEVICE_PRESETS[deviceMode];
	return { width: `${preset.width}px`, height: `${preset.height}px` };
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
	const [deviceMode, setDeviceMode] = useState<DeviceMode>('responsive');
	const [previewKey, setPreviewKey] = useState(0);

	// Preview URL
	const previewUrl = `/p/${projectId}/__preview/`;

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

	const dimensions = getIframeDimensions(deviceMode);

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Toolbar */}
			<div
				className={`
					flex h-10 shrink-0 items-center justify-between border-b border-border px-2
				`}
			>
				<div className="flex items-center gap-1">
					<span className="px-2 text-xs font-medium text-text-secondary">Preview</span>
				</div>

				<div className="flex items-center gap-1">
					{/* Device mode buttons */}
					<div className="flex items-center rounded-sm border border-border">
						<Tooltip content="Responsive">
							<Button
								variant="ghost"
								size="icon"
								className={cn('size-7 rounded-none rounded-l-sm', deviceMode === 'responsive' && 'bg-bg-tertiary')}
								onClick={() => setDeviceMode('responsive')}
							>
								<Maximize2 className="size-3.5" />
							</Button>
						</Tooltip>
						<Tooltip content="Mobile (375x667)">
							<Button
								variant="ghost"
								size="icon"
								className={cn('size-7 rounded-none border-l border-border', deviceMode === 'mobile' && 'bg-bg-tertiary')}
								onClick={() => setDeviceMode('mobile')}
							>
								<Smartphone className="size-3.5" />
							</Button>
						</Tooltip>
						<Tooltip content="Tablet (768x1024)">
							<Button
								variant="ghost"
								size="icon"
								className={cn('size-7 rounded-none border-l border-border', deviceMode === 'tablet' && 'bg-bg-tertiary')}
								onClick={() => setDeviceMode('tablet')}
							>
								<Tablet className="size-3.5" />
							</Button>
						</Tooltip>
						<Tooltip content="Desktop (1280x800)">
							<Button
								variant="ghost"
								size="icon"
								className={cn('size-7 rounded-none rounded-r-sm border-l border-border', deviceMode === 'desktop' && 'bg-bg-tertiary')}
								onClick={() => setDeviceMode('desktop')}
							>
								<Monitor className="size-3.5" />
							</Button>
						</Tooltip>
					</div>

					<div className="mx-1 h-4 w-px bg-border" />

					{/* Action buttons */}
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
			<div
				className={`
					relative flex flex-1 items-center justify-center overflow-auto
					bg-bg-tertiary p-4
				`}
			>
				{/* Loading overlay */}
				{isLoading && (
					<div
						className={`
							absolute inset-0 z-10 flex items-center justify-center bg-bg-tertiary/80
						`}
					>
						<div className="flex flex-col items-center gap-2">
							<RefreshCw className="size-6 animate-spin text-accent" />
							<span className="text-sm text-text-secondary">Loading preview...</span>
						</div>
					</div>
				)}

				{/* Iframe container */}
				<div
					className={cn('relative overflow-hidden bg-white shadow-lg', deviceMode !== 'responsive' && 'rounded-lg border border-border')}
					style={{
						width: dimensions.width,
						height: dimensions.height,
						maxWidth: '100%',
						maxHeight: '100%',
					}}
				>
					<iframe
						key={previewKey}
						ref={iframeReference}
						src={previewUrl}
						onLoad={handleLoad}
						data-preview
						className="size-full border-0"
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
						title="Project Preview"
					/>
				</div>

				{/* Device dimensions label */}
				{deviceMode !== 'responsive' && (
					<div
						className={`
							absolute bottom-2 left-1/2 -translate-x-1/2 rounded-sm bg-bg-secondary
							px-2 py-1 text-xs text-text-secondary
						`}
					>
						{DEVICE_PRESETS[deviceMode].width} x {DEVICE_PRESETS[deviceMode].height}
					</div>
				)}
			</div>
		</div>
	);
}
