/**
 * Side-effect-only hooks for the IDE shell: message listeners, keyboard shortcuts,
 * window.name setup, dependency error auto-expand, and cursor debounce cleanup.
 */

import { useEffect, useRef } from 'react';

import { getDependencyErrorCount, subscribeDependencyErrors } from '@/features/file-tree/dependency-error-store';
import { useStore } from '@/lib/store';

import type { MutableRefObject } from 'react';

interface UseIDEEffectsOptions {
	projectId: string;
	goToFilePosition: (file: string, position: { line: number; column: number }) => void;
	handleSaveReference: MutableRefObject<() => Promise<void>>;
	previewIframeReference: MutableRefObject<HTMLIFrameElement | null>;
	cursorUpdateTimeoutReference: MutableRefObject<ReturnType<typeof setTimeout> | undefined>;
}

export function useIDEEffects({
	projectId,
	goToFilePosition,
	handleSaveReference,
	previewIframeReference,
	cursorUpdateTimeoutReference,
}: UseIDEEffectsOptions) {
	// Auto-expand dependencies panel when new errors are detected.
	const showDependenciesPanel = useStore((state) => state.showDependenciesPanel);
	const previousDependencyErrorCount = useRef(0);
	useEffect(() => {
		return subscribeDependencyErrors(() => {
			const currentCount = getDependencyErrorCount();
			if (currentCount > previousDependencyErrorCount.current) {
				showDependenciesPanel();
			}
			previousDependencyErrorCount.current = currentCount;
		});
	}, [showDependenciesPanel]);

	// Listen for __open-file messages from the preview iframe (error overlay)
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (event.origin !== globalThis.location.origin) return;
			if (event.data?.type === '__open-file' && typeof event.data.file === 'string') {
				const file: string = event.data.file.startsWith('/') ? event.data.file : `/${event.data.file}`;
				const line = typeof event.data.line === 'number' ? event.data.line : 1;
				const column = typeof event.data.column === 'number' ? event.data.column : 1;
				goToFilePosition(file, { line, column });
			}
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [goToFilePosition]);

	// Set a known window name so full-screen preview can focus this tab via window.open()
	useEffect(() => {
		window.name = `worker-ide:${projectId}`;
	}, [projectId]);

	// Listen for __open-file via BroadcastChannel (full-screen preview in another tab)
	useEffect(() => {
		const channelName = `worker-ide:${projectId}`;
		const broadcastChannel = new BroadcastChannel(channelName);

		const handleBroadcast = (event: MessageEvent) => {
			if (event.data?.type === '__open-file' && typeof event.data.file === 'string') {
				const file: string = event.data.file.startsWith('/') ? event.data.file : `/${event.data.file}`;
				const line = typeof event.data.line === 'number' ? event.data.line : 1;
				const column = typeof event.data.column === 'number' ? event.data.column : 1;
				goToFilePosition(file, { line, column });
				broadcastChannel.postMessage({ type: '__open-file-ack' });
			}
		};

		broadcastChannel.addEventListener('message', handleBroadcast);

		return () => {
			broadcastChannel.removeEventListener('message', handleBroadcast);
			broadcastChannel.close();
		};
	}, [projectId, goToFilePosition]);

	// Handle #goto=<file>:<line>:<col> hash when IDE tab is opened from full-screen preview
	useEffect(() => {
		const hash = globalThis.location.hash;
		if (!hash.startsWith('#goto=')) return;

		const gotoValue = hash.slice('#goto='.length);
		const match = gotoValue.match(/^(.+):(\d+):(\d+)$/);
		if (!match) return;

		const file = decodeURIComponent(match[1]);
		const line = Number(match[2]);
		const column = Number(match[3]);
		goToFilePosition(file, { line, column });

		// Clear the hash so it doesn't re-trigger on HMR or navigation
		history.replaceState(undefined, '', globalThis.location.pathname + globalThis.location.search);
	}, [goToFilePosition]);

	// Forward bundle errors to the preview iframe so the error overlay shows
	useEffect(() => {
		const handleServerError = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			const error = event.detail;
			if (error?.type !== 'bundle') return;
			previewIframeReference.current?.contentWindow?.postMessage({ type: '__show-error-overlay', error }, globalThis.location.origin);
		};

		globalThis.addEventListener('server-error', handleServerError);
		return () => globalThis.removeEventListener('server-error', handleServerError);
	}, [previewIframeReference]);

	// Keyboard shortcuts
	useEffect(() => {
		const handleKeyDown = (event: KeyboardEvent) => {
			if ((event.ctrlKey || event.metaKey) && event.key === 's') {
				event.preventDefault();
				void handleSaveReference.current();
			}
		};

		globalThis.addEventListener('keydown', handleKeyDown);
		return () => globalThis.removeEventListener('keydown', handleKeyDown);
	}, [handleSaveReference]);

	// Clean up cursor debounce timeout on unmount
	useEffect(() => {
		const timeoutId = cursorUpdateTimeoutReference.current;
		return () => {
			clearTimeout(timeoutId);
		};
	}, [cursorUpdateTimeoutReference]);
}
