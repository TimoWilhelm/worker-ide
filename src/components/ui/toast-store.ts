/**
 * Toast Store
 *
 * Module-level store for toast notifications.
 * Provides an imperative `toast.error()` API callable from anywhere.
 */

// =============================================================================
// Types
// =============================================================================

export interface ToastItem {
	id: string;
	message: string;
	variant: 'error';
}

// =============================================================================
// Store
// =============================================================================

let toasts: ToastItem[] = [];
let nextId = 0;
const listeners = new Set<() => void>();

function emitChange() {
	for (const listener of listeners) {
		listener();
	}
}

export function subscribe(listener: () => void) {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function getSnapshot(): ToastItem[] {
	return toasts;
}

function addToast(message: string, variant: 'error') {
	nextId++;
	toasts = [...toasts, { id: String(nextId), message, variant }];
	emitChange();
}

export function removeToast(id: string) {
	toasts = toasts.filter((t) => t.id !== id);
	emitChange();
}

/**
 * Imperative toast API — call from anywhere (hooks, callbacks, etc.).
 *
 * @example
 * ```ts
 * import { toast } from '@/components/ui/toast-store';
 * toast.error('Failed to delete file');
 * ```
 */
export const toast = {
	error: (message: string) => addToast(message, 'error'),
};
