/**
 * Toast Store
 *
 * Zustand store for toast notifications.
 * Provides an imperative `toast.error()` API callable from anywhere.
 */

import { createStore, useStore } from 'zustand';

// =============================================================================
// Types
// =============================================================================

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastItem {
	id: string;
	message: string;
	variant: 'error' | 'info' | 'success';
	action?: ToastAction;
}

// =============================================================================
// Store
// =============================================================================

interface ToastState {
	items: ToastItem[];
	nextId: number;
}

const toastStore = createStore<ToastState>(() => ({
	items: [],
	nextId: 0,
}));

interface AddToastOptions {
	action?: ToastAction;
}

function addToast(message: string, variant: 'error' | 'info' | 'success', options?: AddToastOptions) {
	toastStore.setState((state) => ({
		nextId: state.nextId + 1,
		items: [...state.items, { id: String(state.nextId + 1), message, variant, action: options?.action }],
	}));
}

export function removeToast(id: string) {
	toastStore.setState((state) => ({
		items: state.items.filter((t) => t.id !== id),
	}));
}

// =============================================================================
// React hook
// =============================================================================

export function useToasts(): ToastItem[] {
	return useStore(toastStore, (state) => state.items);
}

// =============================================================================
// Imperative API — callable from anywhere (hooks, callbacks, etc.)
// =============================================================================

/**
 * Imperative toast API — call from anywhere (hooks, callbacks, etc.).
 *
 * @example
 * ```ts
 * import { toast } from '@/components/ui/toast-store';
 * toast.error('Failed to delete file');
 * toast.success('Copied to clipboard');
 * ```
 */
export const toast = {
	error: (message: string, options?: AddToastOptions) => addToast(message, 'error', options),
	info: (message: string, options?: AddToastOptions) => addToast(message, 'info', options),
	success: (message: string, options?: AddToastOptions) => addToast(message, 'success', options),
};

// =============================================================================
// Test helpers
// =============================================================================

/** Underlying store instance — exposed for direct access in tests. */
export { toastStore };
