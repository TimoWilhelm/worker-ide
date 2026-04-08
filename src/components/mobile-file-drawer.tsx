/**
 * Mobile File Drawer Component
 *
 * Slide-in drawer from the left for accessing the file tree on mobile.
 * Uses Base UI Dialog primitives for accessible overlay behavior.
 */

import { Dialog } from '@base-ui-components/react/dialog';
import { AnimatePresence, motion } from 'motion/react';

import { overlayVariants, slideLeftVariants, springDefault, tweenFast } from '@/lib/motion-config';
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
			<AnimatePresence>
				{mobileFileTreeOpen && (
					<Dialog.Portal keepMounted>
						<Dialog.Backdrop
							render={<motion.div variants={overlayVariants} initial="hidden" animate="visible" exit="exit" transition={tweenFast} />}
							className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
						/>
						<Dialog.Popup
							render={<motion.div variants={slideLeftVariants} initial="hidden" animate="visible" exit="exit" transition={springDefault} />}
							className={cn(`
								fixed inset-y-0 left-0 z-50 flex w-72 flex-col bg-bg-secondary shadow-xl
							`)}
						>
							<Dialog.Title className="sr-only">File Explorer</Dialog.Title>
							<Dialog.Description className="sr-only">Browse and select project files</Dialog.Description>
							{children}
						</Dialog.Popup>
					</Dialog.Portal>
				)}
			</AnimatePresence>
		</Dialog.Root>
	);
}
