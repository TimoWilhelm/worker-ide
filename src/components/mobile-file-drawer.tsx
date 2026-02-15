/**
 * Mobile File Drawer Component
 *
 * Slide-in drawer from the left for accessing the file tree on mobile.
 * Uses Radix Dialog primitives for accessible overlay behavior.
 */

import { Dialog } from 'radix-ui';

import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

// =============================================================================
// Component
// =============================================================================

interface MobileFileDrawerProperties {
	children: ReactNode;
}

export function MobileFileDrawer({ children }: MobileFileDrawerProperties) {
	const mobileFileTreeOpen = useStore((state) => state.mobileFileTreeOpen);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);

	return (
		<Dialog.Root open={mobileFileTreeOpen} onOpenChange={(open) => !open && toggleMobileFileTree()}>
			<Dialog.Portal>
				<Dialog.Overlay className={cn('fixed inset-0 z-40 bg-black/50 backdrop-blur-sm', 'data-[state=open]:animate-fade-in')} />
				<Dialog.Content
					className={cn(
						'fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-bg-secondary shadow-xl',
						'data-[state=open]:animate-slide-in-left',
					)}
				>
					<Dialog.Title className="sr-only">File Explorer</Dialog.Title>
					<Dialog.Description className="sr-only">Browse and select project files</Dialog.Description>
					{children}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}
