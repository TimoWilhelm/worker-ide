/**
 * Login Page
 *
 * GitHub OAuth login page. Shown when the user is not authenticated.
 * The AuthGate in app.tsx ensures this is only rendered for unauthenticated users.
 *
 * Single-column centered layout over the halftone shader background.
 */

import { Github, Hexagon } from 'lucide-react';
import { Suspense } from 'react';

import { HalftoneBackground } from '@/components/halftone-background';
import { Button } from '@/components/ui/button';
import { authClient } from '@/lib/auth-client';

function handleGitHubLogin() {
	void authClient.signIn.social({ provider: 'github', callbackURL: '/' });
}

export default function LoginPage() {
	return (
		<div className="relative flex h-dvh flex-col items-center justify-center">
			{/* Halftone shader background */}
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			<div
				className="
					relative z-0 flex w-full max-w-md flex-col items-center gap-8 px-6
				"
			>
				{/* Branding */}
				<div className="flex flex-col items-center gap-3">
					<Hexagon className="size-10 text-accent" strokeWidth={1.5} />
					<h1 className="text-2xl font-semibold tracking-tight text-text-primary">Codemaxxing</h1>
				</div>

				{/* Card-like form area */}
				<div
					className="
						flex w-full flex-col items-center gap-6 rounded-xl border border-border
						bg-bg-primary/80 p-8 shadow-sm backdrop-blur-md
					"
				>
					<div className="flex flex-col items-center gap-1 text-center">
						<h2 className="text-lg font-semibold tracking-tight text-text-primary">Welcome</h2>
						<p className="text-sm text-text-secondary">Sign in to start building</p>
					</div>

					<Button onClick={handleGitHubLogin} className="w-full gap-2" size="lg">
						<Github className="size-5" />
						Continue with GitHub
					</Button>
				</div>

				<p className="text-center text-xs text-text-secondary/60">
					By signing in, you agree to our{' '}
					<a
						href="https://codemaxxing.ai/terms"
						target="_blank"
						rel="noopener noreferrer"
						className="
							underline
							hover:text-text-secondary
						"
					>
						terms&nbsp;of&nbsp;service
					</a>{' '}
					and{' '}
					<a
						href="https://codemaxxing.ai/privacy"
						target="_blank"
						rel="noopener noreferrer"
						className="
							underline
							hover:text-text-secondary
						"
					>
						privacy&nbsp;policy
					</a>
					.
				</p>
			</div>
		</div>
	);
}
