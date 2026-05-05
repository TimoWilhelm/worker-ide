import { Toast } from '@base-ui/react/toast';

export interface ToastAction {
	label: string;
	onClick: () => void;
}

export interface ToastData {
	variant: 'error' | 'info' | 'success';
	action?: ToastAction;
}

export const toastManager = Toast.createToastManager();

interface AddToastOptions {
	title?: string;
	duration?: number;
	persist?: boolean;
	action?: ToastAction;
}
const TITLED_TOAST_DURATION = 8000;

function addToast(message: string, variant: 'error' | 'info' | 'success', options?: AddToastOptions) {
	// Toasts with a title contain more text, so auto-extend the duration.
	const timeout = options?.persist ? 0 : (options?.duration ?? (options?.title ? TITLED_TOAST_DURATION : undefined));
	const toastOptions = {
		title: options?.title,
		description: message,
		type: variant,
		data: {
			variant,
			action: options?.action,
		},
	};

	toastManager.add(timeout === undefined ? toastOptions : { ...toastOptions, timeout });
}

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
