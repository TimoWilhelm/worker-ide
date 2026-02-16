/**
 * Root Application Component
 *
 * Sets up global providers (React Query, error boundaries) and routes.
 * - `/` renders the landing page (template selection, clone, recent projects)
 * - `/p/<hex64>` renders the IDE shell for a specific project
 */

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Suspense, useEffect, useState } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { IDEShell } from '@/components/ide-shell';
import { Spinner } from '@/components/ui/spinner';
import { Toaster } from '@/components/ui/toast';
import { LandingPage } from '@/features/landing';
import { trackProject } from '@/lib/recent-projects';

// =============================================================================
// Query Client
// =============================================================================

const queryClient = new QueryClient({
	defaultOptions: {
		queries: {
			staleTime: 1000 * 60,
			retry: 1,
			refetchOnWindowFocus: false,
		},
	},
});

// =============================================================================
// Loading / Error Fallbacks
// =============================================================================

function LoadingFallback() {
	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary">
			<div className="flex flex-col items-center gap-4">
				<Spinner size="lg" />
				<p className="text-text-secondary">Loading Worker IDE...</p>
			</div>
		</div>
	);
}

function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary p-4">
			<div
				className="
					max-w-lg rounded-xl border border-error/50 bg-bg-secondary p-10 shadow-lg
				"
			>
				<h1 className="mb-4 text-xl font-semibold text-error">Something went wrong</h1>
				<pre
					className="
						mb-8 max-h-48 overflow-auto rounded-md bg-bg-tertiary p-5 font-mono
						text-sm/relaxed text-text-secondary
					"
				>
					{error.message}
				</pre>
				<button
					onClick={resetErrorBoundary}
					className="
						cursor-pointer rounded-md bg-accent px-5 py-2.5 text-sm font-medium
						text-white transition-colors
						hover:bg-accent-hover
					"
				>
					Try again
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// Routing
// =============================================================================

/**
 * Extract a project ID from the current URL path.
 * Returns undefined if not on a project route.
 */
function getProjectIdFromUrl(): string | undefined {
	const path = globalThis.location.pathname;
	const match = path.match(/^\/p\/([a-f0-9]{64})/i);
	if (match) {
		return match[1].toLowerCase();
	}
	return undefined;
}

/**
 * Check if the current URL is the landing page (root path).
 */
function isLandingPage(): boolean {
	const path = globalThis.location.pathname;
	return !getProjectIdFromUrl() && (path === '/' || path === '');
}

function AppContent() {
	const [projectId] = useState(getProjectIdFromUrl);
	const [showLanding] = useState(isLandingPage);

	// Track current project in recent list
	useEffect(() => {
		if (projectId) {
			trackProject(projectId);
		}
	}, [projectId]);

	// Landing page at root
	if (showLanding) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<LandingPage />
			</Suspense>
		);
	}

	// IDE shell for project routes
	if (projectId) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<IDEShell projectId={projectId} />
			</Suspense>
		);
	}

	// Fallback (unknown route)
	return <LoadingFallback />;
}

// =============================================================================
// Root App Component
// =============================================================================

export function App() {
	return (
		<ErrorBoundary fallback={ErrorFallback}>
			<QueryClientProvider client={queryClient}>
				<AppContent />
				<Toaster />
			</QueryClientProvider>
		</ErrorBoundary>
	);
}
