import { ArrowLeft, Hexagon, Menu } from 'lucide-react';
import { motion } from 'motion/react';
import { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';

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

function getSettingsBackTarget(state: unknown): string | undefined {
	if (!state || typeof state !== 'object' || !('from' in state)) {
		return undefined;
	}

	return typeof state.from === 'string' ? state.from : undefined;
}

export default function SettingsLayout({ children, activePath }: SettingsLayoutProperties) {
	const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
	const location = useLocation();
	const navigate = useNavigate();
	const backTarget = getSettingsBackTarget(location.state);
	const navigationState = backTarget ? { from: backTarget } : undefined;

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

				<button
					type="button"
					onClick={() => void navigate(backTarget ?? '/')}
					className="
						flex shrink-0 items-center justify-center rounded-md p-1.5
						text-text-secondary transition-colors
						hover:bg-bg-tertiary hover:text-text-primary
					"
					aria-label="Go back"
				>
					<ArrowLeft className="size-4" />
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
										state={navigationState}
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

				<SettingsMobileDrawer
					open={mobileDrawerOpen}
					onOpenChange={setMobileDrawerOpen}
					activePath={activePath}
					navigationState={navigationState}
				/>

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
