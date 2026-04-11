/**
 * Toast Store
 *
 * Base UI toast manager for toast notifications.
 * Provides an imperative `toast.error()` API callable from anywhere.
 */

import { Toast } from '@base-ui/react/toast';

// =============================================================================
// Types
// =============================================================================

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastData {
	variant: 'error' | 'info' | 'success';
	action?: ToastAction;
}

// =============================================================================
// Manager
// =============================================================================

export const toastManager = Toast.createToastManager();

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
	const timeout = options?.duration ?? (options?.title ? TITLED_TOAST_DURATION : undefined);

	toastManager.add({
		title: options?.title,
		description: message,
		type: variant,
		timeout,
		data: {
			variant,
			action: options?.action,
		},
	});
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
