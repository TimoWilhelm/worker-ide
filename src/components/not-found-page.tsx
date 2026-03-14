/**
 * Generic Not Found Page
 *
 * Displayed when navigating to an unknown route.
 * Styled to match ProjectNotFound and other error pages.
 */

import { FileQuestion, Home } from 'lucide-react';

import { Button } from '@/components/ui/button';

export function NotFoundPage() {
	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary p-4">
			<div
				className="
					max-w-lg rounded-xl border border-border bg-bg-secondary p-10 shadow-lg
				"
			>
				<div className="mb-3 flex items-center gap-3">
					<FileQuestion className="size-6 text-text-secondary" />
					<h1 className="text-xl font-semibold text-text-primary">Page not found</h1>
				</div>
				<p className="mb-8 text-sm text-text-secondary">The page you're looking for doesn't exist.</p>
				<Button onClick={() => (globalThis.location.href = '/')}>
					<Home className="size-4" />
					Back to Home
				</Button>
			</div>
		</div>
	);
}
