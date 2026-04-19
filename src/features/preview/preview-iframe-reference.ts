import type { PreviewElementReference } from '@shared/types';

/**
 * Global refs for the preview iframe and origin.
 * Used by iframe-aware features without prop drilling.
 */
export const previewIframeReference: { current: HTMLIFrameElement | undefined } = { current: undefined };
export const previewOriginReference: { current: string | undefined } = { current: undefined };

export type PreviewElementPickerCommand =
	| { type: '__preview-element-picker-start' }
	| { type: '__preview-element-picker-cancel' }
	| { type: '__preview-element-highlight'; reference: PreviewElementReference; sticky?: boolean }
	| { type: '__preview-element-highlight-clear' }
	| { type: '__preview-element-reveal'; reference: PreviewElementReference; sticky?: boolean; scroll?: 'always' | 'if-needed' }
	| { type: '__preview-element-resolve'; requestId: string; reference: PreviewElementReference };

export interface PreviewElementPickedMessage {
	type: '__preview-element-picked';
	reference: PreviewElementReference;
}

export interface PreviewElementPickerCancelledMessage {
	type: '__preview-element-picker-cancelled';
}

const pendingPreviewElementResolves = new Map<string, (found: boolean) => void>();
let stickyPreviewElementHighlightActive = false;

function clearStickyPreviewElementHighlight() {
	if (!stickyPreviewElementHighlightActive) {
		return;
	}

	clearPreviewElementHighlight();
}

if (typeof globalThis !== 'undefined') {
	globalThis.addEventListener('message', (event: MessageEvent) => {
		const previewWindow = previewIframeReference.current?.contentWindow;
		const previewOrigin = previewOriginReference.current;
		if (!previewWindow || !previewOrigin) {
			return;
		}

		if (event.source !== previewWindow || event.origin !== previewOrigin) {
			return;
		}

		const message = event.data;
		if (!message || typeof message !== 'object' || !('type' in message) || message.type !== '__preview-element-resolved') {
			return;
		}

		if (!('requestId' in message) || !('found' in message) || typeof message.requestId !== 'string' || typeof message.found !== 'boolean') {
			return;
		}

		const resolve = pendingPreviewElementResolves.get(message.requestId);
		if (!resolve) {
			return;
		}

		pendingPreviewElementResolves.delete(message.requestId);
		resolve(message.found);
	});

	if (typeof document !== 'undefined') {
		document.addEventListener('pointerdown', clearStickyPreviewElementHighlight, true);
		document.addEventListener('touchstart', clearStickyPreviewElementHighlight, true);
	}

	globalThis.addEventListener('keydown', clearStickyPreviewElementHighlight, true);
	globalThis.addEventListener('wheel', clearStickyPreviewElementHighlight, { capture: true });
}

function getPreviewMessagingTarget(): { previewWindow: Window; previewOrigin: string } | undefined {
	const previewWindow = previewIframeReference.current?.contentWindow;
	const previewOrigin = previewOriginReference.current;
	if (!previewWindow || !previewOrigin) {
		return undefined;
	}

	return { previewWindow, previewOrigin };
}

function postMessageToPreview(command: PreviewElementPickerCommand): boolean {
	const target = getPreviewMessagingTarget();
	if (!target) {
		return false;
	}

	target.previewWindow.postMessage(command, target.previewOrigin);
	return true;
}

export function startPreviewElementPicker(): boolean {
	return postMessageToPreview({ type: '__preview-element-picker-start' });
}

export function cancelPreviewElementPicker(): boolean {
	return postMessageToPreview({ type: '__preview-element-picker-cancel' });
}

export function highlightPreviewElement(reference: PreviewElementReference, options?: { sticky?: boolean }): boolean {
	stickyPreviewElementHighlightActive = options?.sticky ?? false;
	return postMessageToPreview({ type: '__preview-element-highlight', reference, sticky: options?.sticky });
}

export function clearPreviewElementHighlight(): boolean {
	stickyPreviewElementHighlightActive = false;
	return postMessageToPreview({ type: '__preview-element-highlight-clear' });
}

export function revealPreviewElement(
	reference: PreviewElementReference,
	options?: { sticky?: boolean; scroll?: 'always' | 'if-needed' },
): boolean {
	stickyPreviewElementHighlightActive = options?.sticky ?? false;
	return postMessageToPreview({
		type: '__preview-element-reveal',
		reference,
		sticky: options?.sticky,
		scroll: options?.scroll,
	});
}

export function resolvePreviewElement(reference: PreviewElementReference): Promise<boolean | undefined> {
	let unresolvedResult: boolean | undefined;

	const target = getPreviewMessagingTarget();
	if (!target) {
		return Promise.resolve(unresolvedResult);
	}

	const requestId = crypto.randomUUID();
	return new Promise<boolean | undefined>((resolve) => {
		const timeout = setTimeout(() => {
			pendingPreviewElementResolves.delete(requestId);
			resolve(unresolvedResult);
		}, 1000);

		pendingPreviewElementResolves.set(requestId, (found) => {
			clearTimeout(timeout);
			resolve(found);
		});

		target.previewWindow.postMessage({ type: '__preview-element-resolve', requestId, reference }, target.previewOrigin);
	});
}
