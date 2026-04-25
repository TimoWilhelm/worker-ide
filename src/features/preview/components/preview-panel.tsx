import { ExternalLink, RefreshCw, WandSparkles, Wrench } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { LoadingBars } from '@/components/ui/loading-bars';
import { Tooltip } from '@/components/ui/tooltip';
import {
	cancelPreviewElementPicker,
	previewIframeReference,
	previewOriginReference,
	startPreviewElementPicker,
} from '@/features/preview/preview-iframe-reference';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { sanitizePreviewElementReference } from '@shared/preview-element';

export interface PreviewPanelProperties {
	previewUrl: string | undefined;
	previewOrigin: string | undefined;
	isLoadingUrl: boolean;
	refreshPreviewUrl: () => Promise<string | undefined>;
	iframeReference: React.RefObject<HTMLIFrameElement | null>;
	className?: string;
}

export function PreviewPanel({
	previewUrl,
	previewOrigin,
	isLoadingUrl,
	refreshPreviewUrl,
	iframeReference,
	className,
}: PreviewPanelProperties) {
	const rootReference = useRef<HTMLDivElement>(null);
	const pickerButtonReference = useRef<HTMLButtonElement>(null);
	const [isLoading, setIsLoading] = useState(true);
	const [previewKey, setPreviewKey] = useState(0);
	const [isPickerActive, setIsPickerActive] = useState(false);
	const devtoolsVisible = useStore((state) => state.devtoolsVisible);
	const toggleDevtools = useStore((state) => state.toggleDevtools);
	const queuePreviewElementReference = useStore((state) => state.queuePreviewElementReference);
	const showAgentPanel = useStore((state) => state.showAgentPanel);
	const pickerActive = isPickerActive && !!previewUrl;

	const deactivatePicker = useCallback(() => {
		if (!pickerActive) {
			return;
		}

		cancelPreviewElementPicker();
		setIsPickerActive(false);
	}, [pickerActive]);

	const handleLoad = useCallback(() => {
		setIsLoading(false);
	}, []);

	const reloadPreview = useCallback(() => {
		deactivatePicker();
		setIsLoading(true);
		setPreviewKey((previous) => previous + 1);
		globalThis.dispatchEvent(new CustomEvent('preview-refresh'));
	}, [deactivatePicker]);

	const handleRefresh = useCallback(async () => {
		deactivatePicker();
		setIsLoading(true);
		globalThis.dispatchEvent(new CustomEvent('preview-refresh'));

		const refreshedPreviewUrl = await refreshPreviewUrl();
		if (refreshedPreviewUrl !== previewUrl) {
			return;
		}

		if (!previewUrl) {
			setIsLoading(false);
			return;
		}

		setPreviewKey((previous) => previous + 1);
	}, [deactivatePicker, previewUrl, refreshPreviewUrl]);

	const handleOpenExternal = useCallback(() => {
		if (previewUrl) {
			window.open(previewUrl, '_blank', 'noopener,noreferrer');
		}
	}, [previewUrl]);

	const handleTogglePicker = useCallback(() => {
		const didSendMessage = pickerActive ? cancelPreviewElementPicker() : startPreviewElementPicker();
		if (!didSendMessage) {
			return;
		}

		setIsPickerActive((previous) => !previous);
	}, [pickerActive]);

	useEffect(() => {
		const FORCE_REFRESH_DELAY_MS = 500;
		let timer: ReturnType<typeof setTimeout> | undefined;

		const handleForceRefresh = () => {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = undefined;
				reloadPreview();
			}, FORCE_REFRESH_DELAY_MS);
		};

		globalThis.addEventListener('preview-force-refresh', handleForceRefresh);
		return () => {
			globalThis.removeEventListener('preview-force-refresh', handleForceRefresh);
			if (timer) clearTimeout(timer);
		};
	}, [reloadPreview]);

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
			if (previewOrigin && event.origin !== previewOrigin) return;
			if (typeof event.data === 'object' && event.data !== null && event.data.type === '__preview-expired') {
				void refreshPreviewUrl();
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [iframeReference, previewOrigin, refreshPreviewUrl]);

	useEffect(() => {
		previewIframeReference.current = iframeReference.current ?? undefined;
		previewOriginReference.current = previewOrigin;
		return () => {
			previewIframeReference.current = undefined;
			previewOriginReference.current = undefined;
		};
	}, [iframeReference, previewOrigin]);

	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.source !== iframeReference.current?.contentWindow) return;
			if (event.origin !== previewOrigin) return;

			const message = event.data;
			if (!message || typeof message !== 'object' || !('type' in message) || typeof message.type !== 'string') {
				return;
			}

			if (message.type === '__preview-element-picker-cancelled') {
				setIsPickerActive(false);
				return;
			}

			if (message.type !== '__preview-element-picked' || !('reference' in message)) {
				return;
			}

			const reference = sanitizePreviewElementReference(message.reference);
			if (!reference) {
				return;
			}

			setIsPickerActive(false);
			queuePreviewElementReference(reference);
			showAgentPanel();
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [iframeReference, previewOrigin, queuePreviewElementReference, showAgentPanel]);

	useEffect(() => {
		if (!pickerActive) {
			return;
		}

		const cancelPicker = () => {
			cancelPreviewElementPicker();
			setIsPickerActive(false);
		};

		const handlePointerDown = (event: PointerEvent) => {
			const target = event.target;
			if (!(target instanceof Node)) {
				cancelPicker();
				return;
			}

			if (target === iframeReference.current) {
				return;
			}

			if (pickerButtonReference.current?.contains(target)) {
				return;
			}

			if (rootReference.current?.contains(target) && target !== iframeReference.current) {
				cancelPicker();
				return;
			}

			cancelPicker();
		};

		const handleKeyDown = (event: KeyboardEvent) => {
			if (event.key !== 'Escape') {
				return;
			}

			event.preventDefault();
			cancelPicker();
		};

		document.addEventListener('pointerdown', handlePointerDown, true);
		globalThis.addEventListener('keydown', handleKeyDown);

		return () => {
			document.removeEventListener('pointerdown', handlePointerDown, true);
			globalThis.removeEventListener('keydown', handleKeyDown);
		};
	}, [iframeReference, pickerActive]);

	const showLoadingOverlay = isLoading || isLoadingUrl;

	return (
		<div ref={rootReference} className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex min-w-0 items-center gap-1.5">
					<span className="truncate text-xs font-medium text-text-secondary">Preview</span>
				</div>

				<div className="flex shrink-0 items-center gap-1">
					<Tooltip content={pickerActive ? 'Cancel element selection' : 'Send to Agent'}>
						<Button
							ref={pickerButtonReference}
							focusStyle="inset"
							variant="ghost"
							size="icon"
							aria-label="Send to Agent"
							className={cn('size-7', pickerActive && 'bg-accent/10 text-accent hover:bg-accent/15')}
							onClick={handleTogglePicker}
							disabled={!previewUrl}
						>
							<WandSparkles className="size-3.5" />
						</Button>
					</Tooltip>
					<Tooltip content="Toggle DevTools">
						<Button
							focusStyle="inset"
							variant="ghost"
							size="icon"
							aria-label="Toggle DevTools"
							className={cn('size-7', devtoolsVisible && 'text-accent')}
							onClick={toggleDevtools}
						>
							<Wrench className="size-3.5" />
						</Button>
					</Tooltip>
					<Tooltip content="Refresh">
						<Button
							focusStyle="inset"
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="Refresh"
							onClick={() => void handleRefresh()}
						>
							<RefreshCw className="size-3.5" />
						</Button>
					</Tooltip>
					<Tooltip content="Open in new tab">
						<Button
							focusStyle="inset"
							variant="ghost"
							size="icon"
							className="size-7"
							aria-label="Open in new tab"
							onClick={handleOpenExternal}
							disabled={!previewUrl}
						>
							<ExternalLink className="size-3.5" />
						</Button>
					</Tooltip>
				</div>
			</div>

			<div className="relative flex-1 overflow-hidden">
				{showLoadingOverlay && (
					<div
						className="
							absolute inset-0 z-10 flex items-center justify-center bg-bg-tertiary/80
						"
					>
						<div className="flex flex-col items-center gap-3">
							<LoadingBars />
							<span className="text-sm text-text-secondary">Loading preview...</span>
						</div>
					</div>
				)}

				{previewUrl && (
					<iframe
						key={previewKey}
						ref={iframeReference}
						src={previewUrl}
						onLoad={handleLoad}
						data-preview
						className={cn('size-full border-0', showLoadingOverlay ? 'invisible' : 'visible')}
						allow="clipboard-write"
						sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-modals"
						title="Project Preview"
					/>
				)}
			</div>
		</div>
	);
}
