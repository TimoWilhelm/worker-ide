/**
 * Toast Component
 *
 * Accessible toast notifications built on Base UI Toast primitives.
 * Mount `<Toaster />` once near the root of the app.
 */

import { Toast } from '@base-ui-components/react/toast';
import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';

import { toastManager } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';

import type { ToastData } from '@/components/ui/toast-store';

// =============================================================================
// Toaster Component
// =============================================================================

/**
 * Renders the Base UI Toast provider, viewport, and all active toasts.
 * Mount once near the root of the app (e.g. in `app.tsx`).
 */
export function Toaster() {
	return (
		<Toast.Provider toastManager={toastManager} timeout={4000}>
			<Toast.Viewport
				className={cn(
					`
						pointer-events-none fixed right-0 bottom-0 z-9999 m-0 flex w-96
						max-w-[100vw] flex-col gap-2 p-4 outline-none
					`,
				)}
			>
				<ToastList />
			</Toast.Viewport>
		</Toast.Provider>
	);
}

function ToastList() {
	const { toasts, close } = Toast.useToastManager();

	return (
		<>
			{toasts.map((item) => {
				const data: ToastData = item.data ?? { variant: 'info' };
				const variant = data.variant ?? 'info';
				const action = data.action;

				return (
					<Toast.Root
						key={item.id}
						toast={item}
						className={cn(
							`
								pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3
								py-2.5 shadow-lg
							`,
							'bg-bg-secondary text-text-primary',
							variant === 'error' ? 'border-error/40' : 'border-accent/40',
						)}
					>
						{variant === 'error' ? (
							<CircleAlert className="mt-0.5 size-4 shrink-0 text-error" />
						) : variant === 'info' ? (
							<Info className="mt-0.5 size-4 shrink-0 text-accent" />
						) : (
							<CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" />
						)}
						<Toast.Content className="flex flex-1 flex-col gap-1.5">
							{item.title && <Toast.Title className="text-sm font-semibold text-text-primary">{item.title}</Toast.Title>}
							<Toast.Description className="text-sm text-text-primary">{item.description}</Toast.Description>
							{action && (
								<button
									type="button"
									onClick={() => {
										action.onClick();
										close(item.id);
									}}
									className={cn(
										`
											cursor-pointer self-start rounded-md bg-accent px-2.5 py-1 text-xs
											font-medium text-white
										`,
										`
											transition-colors
											hover:bg-accent-hover
										`,
									)}
								>
									{action.label}
								</button>
							)}
						</Toast.Content>
						<Toast.Close
							aria-label="Dismiss"
							className={cn(
								'mt-0.5 flex size-4 shrink-0 cursor-pointer items-center justify-center',
								'rounded-sm text-text-secondary transition-colors',
								'hover:text-text-primary',
							)}
						>
							<X className="size-3" />
						</Toast.Close>
					</Toast.Root>
				);
			})}
		</>
	);
}
