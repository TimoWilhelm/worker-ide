/**
 * Toast Component
 *
 * Accessible toast notifications built on Radix UI Toast primitives.
 * Mount `<Toaster />` once near the root of the app.
 */

import { CircleAlert, CircleCheck, Info, X } from 'lucide-react';
import { Toast } from 'radix-ui';

import { removeToast, useToasts } from '@/components/ui/toast-store';
import { cn } from '@/lib/utils';

// =============================================================================
// Toaster Component
// =============================================================================

/**
 * Renders the Radix Toast provider, viewport, and all active toasts.
 * Mount once near the root of the app (e.g. in `app.tsx`).
 */
export function Toaster() {
	const items = useToasts();

	return (
		<Toast.Provider duration={4000} swipeDirection="right">
			{items.map((item) => (
				<Toast.Root
					key={item.id}
					onOpenChange={(open) => {
						if (!open) removeToast(item.id);
					}}
					className={cn(
						'flex items-start gap-2.5 rounded-lg border px-3 py-2.5 shadow-lg',
						'bg-bg-secondary text-text-primary',
						item.variant === 'error' ? 'border-error/40' : 'border-accent/40',
						'data-[state=open]:animate-toast-slide-in',
						'data-[state=closed]:animate-toast-fade-out',
						'data-[swipe=move]:translate-x-(--radix-toast-swipe-move-x)',
						`
							data-[swipe=cancel]:translate-x-0
							data-[swipe=cancel]:transition-transform
						`,
						'data-[swipe=end]:animate-toast-swipe-out',
					)}
				>
					{item.variant === 'error' ? (
						<CircleAlert className="mt-0.5 size-4 shrink-0 text-error" />
					) : item.variant === 'info' ? (
						<Info className="mt-0.5 size-4 shrink-0 text-accent" />
					) : (
						<CircleCheck className="mt-0.5 size-4 shrink-0 text-accent" />
					)}
					<div className="flex flex-1 flex-col gap-1.5">
						<Toast.Description className="text-sm text-text-primary">{item.message}</Toast.Description>
						{item.action && (
							<button
								type="button"
								onClick={() => {
									item.action?.onClick();
									removeToast(item.id);
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
								{item.action.label}
							</button>
						)}
					</div>
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
			))}

			<Toast.Viewport
				className={cn('fixed right-0 bottom-0 z-9999 m-0 flex w-96 max-w-[100vw] list-none', 'flex-col gap-2 p-4 outline-none')}
			/>
		</Toast.Provider>
	);
}
