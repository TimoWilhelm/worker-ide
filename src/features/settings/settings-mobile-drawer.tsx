import { Dialog } from '@base-ui/react/dialog';
import { Hexagon } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { Link } from 'react-router';

import { BetaIndicator } from '@/components/beta-indicator';
import { useDeferredOpen } from '@/hooks/use-deferred-open';
import { overlayVariants, slideLeftVariants, springCritical, springSnappy, tweenFast } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { SETTINGS_NAV_ITEMS } from './settings-nav-items';

interface SettingsMobileDrawerProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	activePath: string;
	navigationState?: { from: string };
}

export function SettingsMobileDrawer({ open, onOpenChange, activePath, navigationState }: SettingsMobileDrawerProperties) {
	const { dialogOpen, show, onExitComplete } = useDeferredOpen(open);

	return (
		<Dialog.Root open={dialogOpen} onOpenChange={onOpenChange}>
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
							<Dialog.Title className="sr-only">Settings navigation</Dialog.Title>
							<Dialog.Description className="sr-only">Navigate between settings pages</Dialog.Description>

							<div className="flex h-12 shrink-0 items-center border-b border-border px-4">
								<Link
									to="/"
									className="
										flex shrink-0 items-center gap-1 text-accent transition-colors
										hover:text-accent-hover
									"
									aria-label="Back to home"
									onClick={() => onOpenChange(false)}
								>
									<Hexagon className="size-4" />
									<BetaIndicator />
								</Link>
							</div>

							<nav className="flex-1 p-3">
								<ul className="flex flex-col gap-0.5">
									{SETTINGS_NAV_ITEMS.map((item) => {
										const Icon = item.icon;
										const isActive = activePath === item.href;
										return (
											<li key={item.href} className="relative">
												{isActive && (
													<motion.span
														layoutId="settings-mobile-nav-indicator"
														className="absolute inset-0 rounded-md bg-bg-tertiary"
														transition={springSnappy}
													/>
												)}
												<Link
													to={item.href}
													state={navigationState}
													onClick={() => onOpenChange(false)}
													className={cn(
														`
															relative flex items-center gap-2.5 rounded-md px-3 py-2 text-sm
															transition-colors
														`,
														isActive
															? 'font-medium text-text-primary'
															: `
																text-text-secondary
																hover:bg-bg-tertiary hover:text-text-primary
															`,
													)}
												>
													<Icon className="size-4 shrink-0" />
													{item.label}
												</Link>
											</li>
										);
									})}
								</ul>
							</nav>
						</Dialog.Popup>
					</Dialog.Portal>
				)}
			</AnimatePresence>
		</Dialog.Root>
	);
}
