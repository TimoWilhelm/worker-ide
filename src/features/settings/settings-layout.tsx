/**
 * Settings Layout
 *
 * Header shows the app icon (desktop) or hamburger menu (mobile) left of "Settings".
 * Desktop: left sidebar with navigation. Mobile: slidable drawer from the left.
 */

import { Hexagon, Menu } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Link } from 'react-router';

import { BetaIndicator } from '@/components/beta-indicator';
import { Tooltip } from '@/components/ui/tooltip';
import { UserMenu } from '@/features/user-menu';
import { springSnappy } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import { SettingsMobileDrawer } from './settings-mobile-drawer';
import { SETTINGS_NAV_ITEMS } from './settings-nav-items';

interface SettingsLayoutProperties {
	children: React.ReactNode;
	activePath: string;
}

export default function SettingsLayout({ children, activePath }: SettingsLayoutProperties) {
	const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);

	return (
		<div className="flex h-dvh flex-col bg-bg-primary">
			<header
				className="
					flex h-12 shrink-0 items-center gap-3 border-b border-border
					bg-bg-secondary px-4
				"
			>
				<button
					onClick={() => setMobileDrawerOpen(true)}
					className="
						rounded-md p-1.5 text-text-secondary transition-colors
						hover:bg-bg-tertiary hover:text-text-primary
						sm:hidden
					"
					aria-label="Open settings menu"
				>
					<Menu className="size-4" />
				</button>

				<Tooltip content="Back to home">
					<Link
						to="/"
						className="
							hidden shrink-0 items-center gap-1 text-accent transition-colors
							hover:text-accent-hover
							sm:flex
						"
						aria-label="Back to home"
					>
						<Hexagon className="size-4" />
						<BetaIndicator />
					</Link>
				</Tooltip>

				<h1 className="flex-1 text-sm font-semibold text-text-primary">Settings</h1>
				<UserMenu />
			</header>

			<div className="flex min-h-0 flex-1">
				<nav
					className="
						hidden w-56 shrink-0 flex-col border-r border-border bg-bg-secondary
						sm:flex
					"
				>
					<ul className="flex flex-col gap-0.5 p-3">
						{SETTINGS_NAV_ITEMS.map((item) => {
							const Icon = item.icon;
							const isActive = activePath === item.href;
							return (
								<li key={item.href} className="relative">
									{isActive && (
										<motion.span
											layoutId="settings-nav-indicator"
											className="absolute inset-0 rounded-md bg-bg-tertiary"
											transition={springSnappy}
										/>
									)}
									<Link
										to={item.href}
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

				<SettingsMobileDrawer open={mobileDrawerOpen} onOpenChange={setMobileDrawerOpen} activePath={activePath} />

				<main
					className="
						flex-1 overflow-y-auto p-4
						sm:p-6
					"
				>
					<div className="mx-auto max-w-lg">{children}</div>
				</main>
			</div>
		</div>
	);
}
