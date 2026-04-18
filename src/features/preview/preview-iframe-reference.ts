import type { PreviewElementReference } from '@/lib/preview-element-reference';

/**
 * Global refs for the preview iframe and origin.
 * Used by iframe-aware features without prop drilling.
 */
export const previewIframeReference: { current: HTMLIFrameElement | undefined } = { current: undefined };
export const previewOriginReference: { current: string | undefined } = { current: undefined };

export type PreviewElementPickerCommand =
	| { type: '__preview-element-picker-start' }
	| { type: '__preview-element-picker-cancel' }
	| { type: '__preview-element-highlight'; selector: string }
	| { type: '__preview-element-highlight-clear' }
	| { type: '__preview-element-reveal'; selector: string }
	| { type: '__preview-element-resolve'; requestId: string; selector: string };

export interface PreviewElementPickedMessage extends PreviewElementReference {
	type: '__preview-element-picked';
}

export interface PreviewElementPickerCancelledMessage {
	type: '__preview-element-picker-cancelled';
}

const pendingPreviewElementResolves = new Map<string, (found: boolean) => void>();

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
}

function getPreviewMessagingTarget(): { previewWindow: Window; previewOrigin: string } | undefined {
	const previewWindow = previewIframeReference.current?.contentWindow;
	const previewOrigin = previewOriginReference.current;
	if (!previewWindow || !previewOrigin) {
		return undefined;
	}

	return { previewWindow, previewOrigin };
}

export function postMessageToPreview(command: PreviewElementPickerCommand): boolean {
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

export function highlightPreviewElement(selector: string): boolean {
	return postMessageToPreview({ type: '__preview-element-highlight', selector });
}

export function clearPreviewElementHighlight(): boolean {
	return postMessageToPreview({ type: '__preview-element-highlight-clear' });
}

export function revealPreviewElement(selector: string): boolean {
	return postMessageToPreview({ type: '__preview-element-reveal', selector });
}

export function resolvePreviewElement(selector: string): Promise<boolean | undefined> {
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

		target.previewWindow.postMessage({ type: '__preview-element-resolve', requestId, selector }, target.previewOrigin);
	});
}
