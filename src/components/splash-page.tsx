/**
 * Splash Page
 *
 * Shown on the bare domain (e.g., `localhost:3000`).
 * A simple marketing/info page that explains the project
 * and links to the app subdomain where the actual IDE lives.
 */

import { ArrowRight, Cloud, Code, Github, Hexagon, Moon, Sun, Zap } from 'lucide-react';
import { Suspense } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { VersionBadge } from '@/components/version-badge';
import { HalftoneBackground } from '@/features/landing/halftone-background';
import { useTheme } from '@/hooks/use-theme';
import { getIdeOrigin } from '@/lib/preview-origin';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

const appUrl = getIdeOrigin();

const FEATURES = [
	{
		icon: Cloud,
		title: 'Runs on the Edge',
		description: 'Your code runs on Cloudflare Workers — globally distributed, instantly available.',
	},
	{
		icon: Code,
		title: 'Full IDE in the Browser',
		description: 'Editor, terminal output, live preview, git, and AI assistant — no installs needed.',
	},
	{
		icon: Zap,
		title: 'Instant Preview',
		description: 'See changes in real time with hot module replacement and isolated preview sandboxes.',
	},
];

export function SplashPage() {
	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	return (
		<div className="relative flex h-dvh flex-col items-center overflow-y-auto">
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			{/* Header actions */}
			<div className="fixed top-4 right-4 z-10 flex items-center gap-1">
				<a
					href="https://github.com/AnomalyCo/worker-ide"
					target="_blank"
					rel="noopener noreferrer"
					aria-label="GitHub repository"
					className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'bg-bg-secondary/40 backdrop-blur-sm' })}
				>
					<Github className="size-4" />
				</a>
				<Button
					variant="ghost"
					size="icon"
					aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					onClick={() => setColorScheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
					className="bg-bg-secondary/40 backdrop-blur-sm"
				>
					{resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>
			</div>

			{/* Main content */}
			<main
				className="
					relative z-0 w-full max-w-xl px-6 pt-24 pb-12
					sm:pt-32
				"
			>
				{/* Hero */}
				<div className="mb-12 flex flex-col items-center gap-4 text-center">
					<Hexagon className="size-10 text-accent" strokeWidth={1.5} />
					<h1
						className="
							text-3xl font-bold tracking-tight text-text-primary
							sm:text-4xl
						"
					>
						Worker IDE
					</h1>
					<p className="max-w-md text-sm/relaxed text-text-secondary">
						A browser-based development environment for building Cloudflare Workers. Write, preview, and deploy — all from your browser.
					</p>
					<a href={appUrl} className={cn(buttonVariants({ size: 'lg' }), 'mt-4 gap-2')}>
						Open the App
						<ArrowRight className="size-4" />
					</a>
				</div>

				{/* Feature cards */}
				<div
					className="
						grid gap-3
						sm:grid-cols-3
					"
				>
					{FEATURES.map((feature) => (
						<div
							key={feature.title}
							className={cn(
								`
									rounded-lg border border-border bg-bg-secondary/40 p-4 backdrop-blur-sm
								`,
								`
									transition-colors
									hover:border-accent/30 hover:bg-bg-secondary/60
								`,
							)}
						>
							<feature.icon className="mb-2 size-5 text-accent" strokeWidth={1.5} />
							<h3 className="mb-1 text-xs font-semibold text-text-primary">{feature.title}</h3>
							<p className="text-xs/relaxed text-text-secondary">{feature.description}</p>
						</div>
					))}
				</div>
			</main>

			<VersionBadge className="fixed right-4 bottom-4" />
		</div>
	);
}
