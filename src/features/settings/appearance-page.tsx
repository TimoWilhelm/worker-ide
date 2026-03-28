/**
 * Appearance Settings Page
 *
 * Theme selector with Light / Dark / System options.
 * Uses the existing colorScheme state from the Zustand store.
 */

import { Monitor, Moon, Sun } from 'lucide-react';

import { useTheme } from '@/hooks/use-theme';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

type ColorScheme = 'light' | 'dark' | 'system';

const THEME_OPTIONS: Array<{
	value: ColorScheme;
	label: string;
	description: string;
	icon: React.ComponentType<{ className?: string }>;
}> = [
	{ value: 'light', label: 'Light', description: 'Always use light mode.', icon: Sun },
	{ value: 'dark', label: 'Dark', description: 'Always use dark mode.', icon: Moon },
	{ value: 'system', label: 'System', description: 'Follow your operating system preference.', icon: Monitor },
];

export default function AppearancePage() {
	const resolvedTheme = useTheme();
	const colorScheme = useStore((state) => state.colorScheme);
	const setColorScheme = useStore((state) => state.setColorScheme);

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h2 className="mb-1 text-lg font-semibold text-text-primary">Appearance</h2>
				<p className="text-sm text-text-secondary">
					Customize how the app looks. Currently using <strong className="text-text-primary">{resolvedTheme}</strong> mode.
				</p>
			</div>

			{/* Theme selector */}
			<section>
				<h3
					className="
						mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
					"
				>
					Theme
				</h3>
				<div className="grid grid-cols-3 gap-3">
					{THEME_OPTIONS.map((option) => {
						const isSelected = colorScheme === option.value;
						const Icon = option.icon;
						return (
							<button
								key={option.value}
								onClick={() => setColorScheme(option.value)}
								className={cn(
									`
										flex cursor-pointer flex-col items-center gap-2 rounded-lg border p-4
										transition-colors
									`,
									isSelected
										? 'border-accent bg-accent/5 text-text-primary'
										: `
											border-border bg-bg-secondary/40 text-text-secondary
											hover:border-accent/50 hover:bg-bg-secondary/80
										`,
								)}
							>
								<Icon className={cn('size-5', isSelected && 'text-accent')} />
								<span className="text-xs font-medium">{option.label}</span>
							</button>
						);
					})}
				</div>
				<p className="mt-3 text-xs text-text-secondary">
					{colorScheme === 'system'
						? 'The theme will automatically switch based on your OS settings.'
						: `${colorScheme === 'dark' ? 'Dark' : 'Light'} mode is always active regardless of OS settings.`}
				</p>
			</section>
		</div>
	);
}
