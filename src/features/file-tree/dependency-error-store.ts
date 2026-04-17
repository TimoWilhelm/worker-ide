import { createStore, useStore } from 'zustand';

import { isMessageFromPreview } from '@/lib/preview-origin';

import type { DependencyError } from '@shared/types';

const ERROR_MESSAGES: Record<DependencyError['code'], string> = {
	unregistered: 'Not registered. Add it via the Dependencies panel.',
	'not-found': 'Package not found. Check the name and version.',
	'resolve-failed': 'Failed to resolve from CDN. The version may be invalid.',
};

interface DependencyErrorState {
	missing: Set<string>;
	invalid: Map<string, string>;
	addMissing: (packageName: string) => void;
	addInvalid: (packageName: string, message: string) => void;
	removeMissing: (packageName: string) => void;
	removeInvalid: (packageName: string) => void;
	reset: () => void;
}

const dependencyErrorStore = createStore<DependencyErrorState>((set, get) => ({
	missing: new Set<string>(),
	invalid: new Map<string, string>(),

	addMissing: (packageName) => {
		if (get().missing.has(packageName)) return;
		set((state) => {
			const next = new Set(state.missing);
			next.add(packageName);
			return { missing: next };
		});
	},

	addInvalid: (packageName, message) => {
		if (get().invalid.get(packageName) === message) return;
		set((state) => {
			const next = new Map(state.invalid);
			next.set(packageName, message);
			return { invalid: next };
		});
	},

	removeMissing: (packageName) => {
		if (!get().missing.has(packageName)) return;
		set((state) => {
			const next = new Set(state.missing);
			next.delete(packageName);
			return { missing: next };
		});
	},

	removeInvalid: (packageName) => {
		if (!get().invalid.has(packageName)) return;
		set((state) => {
			const next = new Map(state.invalid);
			next.delete(packageName);
			return { invalid: next };
		});
	},

	reset: () => set({ missing: new Set(), invalid: new Map() }),
}));

function useDependencyErrors() {
	return useStore(dependencyErrorStore);
}

function removeMissing(packageName: string) {
	dependencyErrorStore.getState().removeMissing(packageName);
}

function removeInvalid(packageName: string) {
	dependencyErrorStore.getState().removeInvalid(packageName);
}

function resetDependencyErrors() {
	dependencyErrorStore.getState().reset();
}

function extractDependencyErrors(errorObject: unknown): DependencyError[] | undefined {
	if (typeof errorObject !== 'object' || errorObject === undefined || errorObject === null) {
		return undefined;
	}
	if (!('dependencyErrors' in errorObject)) return undefined;
	const { dependencyErrors } = errorObject;
	if (!Array.isArray(dependencyErrors)) return undefined;
	return dependencyErrors;
}

function processDependencyErrors(errors: DependencyError[]) {
	const { addMissing, addInvalid } = dependencyErrorStore.getState();

	for (const dependencyError of errors) {
		if (dependencyError.code === 'unregistered') {
			addMissing(dependencyError.packageName);
		} else {
			addInvalid(dependencyError.packageName, ERROR_MESSAGES[dependencyError.code]);
		}
	}
}

// Channel 1: WebSocket server-error dispatched as CustomEvent
function handleServerError(event: Event) {
	if (!(event instanceof CustomEvent)) return;
	const errors = extractDependencyErrors(event.detail);
	if (errors) processDependencyErrors(errors);
}

// Channel 2: Preview iframe postMessage (__server-error)
// The preview runs on a separate subdomain, so validate origin accordingly.
function handleMessage(event: MessageEvent) {
	if (!isMessageFromPreview(event)) return;
	if (event.data?.type !== '__server-error') return;
	const errors = extractDependencyErrors(event.data?.error);
	if (errors) processDependencyErrors(errors);
}

globalThis.addEventListener('server-error', handleServerError);
globalThis.addEventListener('message', handleMessage);

function subscribeDependencyErrors(listener: () => void) {
	return dependencyErrorStore.subscribe(listener);
}

function getDependencyErrorCount() {
	const { missing, invalid } = dependencyErrorStore.getState();
	return missing.size + invalid.size;
}

export { useDependencyErrors, removeMissing, removeInvalid, resetDependencyErrors, subscribeDependencyErrors, getDependencyErrorCount };
