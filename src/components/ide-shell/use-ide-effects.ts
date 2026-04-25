import { useEffect, useRef } from 'react';

import { getDependencyErrorCount, subscribeDependencyErrors } from '@/features/file-tree/dependency-error-store';
import { useProjectDeepLinkApplier } from '@/lib/project-deep-link';
import { useStore } from '@/lib/store';
import { isProjectDeepLinkTarget } from '@shared/project-deep-link';

import { useUnsavedChangesWarning } from './use-unsaved-changes-warning';

import type { RefObject } from 'react';

interface UseIDEEffectsOptions {
	projectId: string;
	previewOrigin: string | undefined;
	handleSaveReference: RefObject<() => Promise<void>>;
	previewIframeReference: RefObject<HTMLIFrameElement | null>;
	cursorUpdateTimeoutReference: RefObject<ReturnType<typeof setTimeout> | undefined>;
}

export function useIDEEffects({
	projectId,
	previewOrigin,
	handleSaveReference,
	previewIframeReference,
	cursorUpdateTimeoutReference,
}: UseIDEEffectsOptions) {
	useUnsavedChangesWarning();
	const applyProjectDeepLink = useProjectDeepLinkApplier();

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

	// Listen for canonical deep-link messages from preview surfaces.
	useEffect(() => {
		const handleMessage = (event: MessageEvent) => {
			if (!previewOrigin || event.origin !== previewOrigin) {
				return;
			}
			if (event.data?.type !== '__deep-link' || !isProjectDeepLinkTarget(event.data.target)) {
				return;
			}

			applyProjectDeepLink(event.data.target);
		};

		globalThis.addEventListener('message', handleMessage);
		return () => globalThis.removeEventListener('message', handleMessage);
	}, [applyProjectDeepLink, previewOrigin]);

	// Set a known window name so full-screen preview can focus this tab via window.open().
	useEffect(() => {
		window.name = `worker-ide:${projectId}`;
	}, [projectId]);

	// Forward bundle errors to the preview iframe so the error overlay shows.
	// The preview is cross-origin, so target its specific origin.
	useEffect(() => {
		const handleServerError = (event: Event) => {
			if (!(event instanceof CustomEvent)) return;
			if (!previewOrigin) return;
			const error = event.detail;
			if (error?.type !== 'bundle') return;
			previewIframeReference.current?.contentWindow?.postMessage({ type: '__show-error-overlay', error }, previewOrigin);
		};

		globalThis.addEventListener('server-error', handleServerError);
		return () => globalThis.removeEventListener('server-error', handleServerError);
	}, [previewIframeReference, previewOrigin]);

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
	});
}
