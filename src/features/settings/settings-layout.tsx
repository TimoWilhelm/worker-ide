/**
 * Settings Layout
 *
 * Shared layout for user-level settings pages (profile, account).
 * Left sidebar with navigation, main content area, back button to home.
 */

import { ArrowLeft, Moon, Palette, Shield, Sun, User } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { useTheme } from '@/hooks/use-theme';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const SETTINGS_NAV_ITEMS = [
	{ label: 'Profile', href: '/settings/profile', icon: User },
	{ label: 'Account', href: '/settings/account', icon: Shield },
	{ label: 'Appearance', href: '/settings/appearance', icon: Palette },
];

interface SettingsLayoutProperties {
	children: React.ReactNode;
	activePath: string;
}

export default function SettingsLayout({ children, activePath }: SettingsLayoutProperties) {
	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	return (
		<div className="flex h-dvh flex-col bg-bg-primary">
			{/* Header */}
			<header
				className="
					flex h-12 shrink-0 items-center gap-3 border-b border-border
					bg-bg-secondary px-4
				"
			>
				<a
					href="/"
					className="
						rounded-md p-1.5 text-text-secondary transition-colors
						hover:bg-bg-tertiary hover:text-text-primary
					"
					aria-label="Back to dashboard"
				>
					<ArrowLeft className="size-4" />
				</a>
				<h1 className="flex-1 text-sm font-semibold text-text-primary">Settings</h1>
				<Button
					variant="ghost"
					size="icon"
					aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					onClick={() => setColorScheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
				>
					{resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>
			</header>

			<div className="flex min-h-0 flex-1">
				{/* Sidebar */}
				<nav
					className="
						hidden w-56 shrink-0 border-r border-border bg-bg-secondary p-3
						sm:block
					"
				>
					<ul className="flex flex-col gap-0.5">
						{SETTINGS_NAV_ITEMS.map((item) => {
							const Icon = item.icon;
							const isActive = activePath === item.href;
							return (
								<li key={item.href}>
									<a
										href={item.href}
										className={cn(
											`
												flex items-center gap-2.5 rounded-md px-3 py-2 text-sm
												transition-colors
											`,
											isActive
												? 'bg-bg-tertiary font-medium text-text-primary'
												: `
													text-text-secondary
													hover:bg-bg-tertiary hover:text-text-primary
												`,
										)}
									>
										<Icon className="size-4 shrink-0" />
										{item.label}
									</a>
								</li>
							);
						})}
					</ul>
				</nav>

				{/* Mobile top tabs */}
				<div
					className="
						flex shrink-0 gap-1 border-b border-border bg-bg-secondary px-3
						sm:hidden
					"
				>
					{SETTINGS_NAV_ITEMS.map((item) => {
						const isActive = activePath === item.href;
						return (
							<a
								key={item.href}
								href={item.href}
								className={cn(
									'border-b-2 px-3 py-2 text-xs font-medium transition-colors',
									isActive ? 'border-accent text-text-primary' : 'border-transparent text-text-secondary hover:text-text-primary',
								)}
							>
								{item.label}
							</a>
						);
					})}
				</div>

				{/* Main content */}
				<main className="flex-1 overflow-y-auto p-6">
					<div className="mx-auto max-w-lg">{children}</div>
				</main>
			</div>
		</div>
	);
}
