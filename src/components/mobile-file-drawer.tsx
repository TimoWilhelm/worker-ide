import { Dialog } from '@base-ui/react/dialog';
import { AnimatePresence, motion } from 'motion/react';

import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { overlayVariants, slideLeftVariants, springCritical, tweenFast } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

interface MobileFileDrawerProperties {
	children: ReactNode;
}

export function MobileFileDrawer({ children }: MobileFileDrawerProperties) {
	const mobileFileTreeOpen = useStore((state) => state.mobileFileTreeOpen);
	const toggleMobileFileTree = useStore((state) => state.toggleMobileFileTree);
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(mobileFileTreeOpen);

	return (
		<Dialog.Root open={dialogOpen} onOpenChange={(nextOpen) => !nextOpen && toggleMobileFileTree()}>
			<AnimatePresence onExitComplete={onExitComplete}>
				{show && (
					<Dialog.Portal keepMounted>
						<Dialog.Backdrop
							render={<motion.div variants={overlayVariants} initial="hidden" animate="visible" exit="exit" transition={tweenFast} />}
							className="fixed inset-0 z-40 bg-black/50 backdrop-blur-sm"
						/>
						<Dialog.Popup
							render={
								<motion.div variants={slideLeftVariants} initial="hidden" animate="visible" exit="exit" transition={springCritical} />
							}
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
