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
	title?: string;
	message: string;
	variant: 'error' | 'info' | 'success';
	/** Custom auto-dismiss duration in ms (overrides the provider default). */
	duration?: number;
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
	/** Optional bold heading displayed above the message */
	title?: string;
	/** Custom auto-dismiss duration in ms */
	duration?: number;
	action?: ToastAction;
}

/** Default auto-dismiss duration for toasts with a title (ms). */
const TITLED_TOAST_DURATION = 8000;

function addToast(message: string, variant: 'error' | 'info' | 'success', options?: AddToastOptions) {
	// Toasts with a title contain more text, so auto-extend the duration.
	const duration = options?.duration ?? (options?.title ? TITLED_TOAST_DURATION : undefined);

	toastStore.setState((state) => ({
		nextId: state.nextId + 1,
		items: [
			...state.items,
			{
				id: String(state.nextId + 1),
				title: options?.title,
				message,
				variant,
				duration,
				action: options?.action,
			},
		],
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
