/**
 * Root Application Component
 *
 * Sets up global providers (React Query, error boundaries) and routes.
 *
 * Routing is driven by the subdomain (host type):
 * - Bare domain  → dashboard at `/`, project IDE at `/p/<projectId>`
 * - preview.*    → handled entirely by the worker (never loads the SPA)
 */

import { MutationCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Check, ClipboardCopy } from 'lucide-react';
import { Suspense, use, useEffect, useRef, useState } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { IDEShell } from '@/components/ide-shell';
import { NotFoundPage } from '@/components/not-found-page';
import { OfflineBanner } from '@/components/offline-banner';
import { ProjectNotFound } from '@/components/project-not-found';
import { Spinner } from '@/components/ui/spinner';
import { Toaster } from '@/components/ui/toast';
import { toast } from '@/components/ui/toast-store';
import { LoginPage } from '@/features/auth';
import { DashboardPage } from '@/features/dashboard';
import { OrgManagementPage } from '@/features/org';
import { usePwaUpdate } from '@/hooks/use-pwa-update';
import { fetchProjectMeta } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { isNetworkError } from '@/lib/utils';
import { parseHost } from '@shared/domain';
import { PROJECT_ID_PATTERN } from '@shared/project-id';

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
	mutationCache: new MutationCache({
		onError: (error) => {
			if (isNetworkError(error)) {
				toast.error('You appear to be offline. Check your connection and try again.');
			}
		},
	}),
});

// =============================================================================
// Loading / Error Fallbacks
// =============================================================================

function LoadingFallback() {
	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary">
			<div className="flex flex-col items-center gap-4">
				<Spinner size="lg" />
				<p className="text-text-secondary">Loading Codemaxxing...</p>
			</div>
		</div>
	);
}

function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	const [copied, setCopied] = useState(false);

	function handleCopy() {
		void navigator.clipboard
			?.writeText(error.message)
			.then(() => {
				setCopied(true);
				setTimeout(() => setCopied(false), 2000);
			})
			.catch(() => {
				// Clipboard API unavailable (HTTP context, iframe restrictions, etc.)
			});
	}

	return (
		<div className="flex h-dvh items-center justify-center bg-bg-primary p-4">
			<div
				className="
					max-w-lg rounded-xl border border-error/50 bg-bg-secondary p-10 shadow-lg
				"
			>
				<div className="mb-3 flex items-center justify-between">
					<h1 className="text-xl font-semibold text-error">Something went wrong</h1>
					<button
						onClick={handleCopy}
						title="Copy error to clipboard"
						className="
							-mr-1.5 cursor-pointer rounded-md p-1.5 text-text-secondary
							transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						"
					>
						{copied ? <Check className="size-4 text-green-500" /> : <ClipboardCopy className="size-4" />}
					</button>
				</div>
				<div className="mb-8">
					<pre
						className="
							max-h-48 overflow-auto rounded-md bg-bg-tertiary p-5 font-mono
							text-sm/relaxed text-text-secondary
						"
					>
						{error.message}
					</pre>
				</div>
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

const hostType = parseHost(globalThis.location.host).type;

function getProjectIdFromUrl(): string | undefined {
	const path = globalThis.location.pathname;
	const match = path.match(/^\/p\/([a-z\d]{1,50})/);
	if (match && PROJECT_ID_PATTERN.test(match[1])) {
		return match[1];
	}
	return undefined;
}

/**
 * Cache of project existence check promises, keyed by projectId.
 * Prevents duplicate fetches when React re-renders during Suspense.
 * False results are evicted after a short TTL so a page refresh can
 * detect a project that was created after the initial check.
 */
const projectExistsCache = new Map<string, Promise<boolean>>();
const FALSE_RESULT_TTL_MS = 30_000;

function checkProjectExists(projectId: string): Promise<boolean> {
	let promise = projectExistsCache.get(projectId);
	if (!promise) {
		promise = fetchProjectMeta(projectId)
			.then(() => true)
			.catch(() => false)
			.then((exists) => {
				if (!exists) {
					setTimeout(() => projectExistsCache.delete(projectId), FALSE_RESULT_TTL_MS);
				}
				return exists;
			});
		projectExistsCache.set(projectId, promise);
	}
	return promise;
}

/**
 * Gate component that verifies a project exists before mounting the full IDE.
 * Uses React 19 `use()` to suspend until the existence check resolves.
 */
function ProjectGate({ projectId }: { projectId: string }) {
	const exists = use(checkProjectExists(projectId));

	if (!exists) {
		return <ProjectNotFound />;
	}

	return <ValidProject projectId={projectId} />;
}

/**
 * Wrapper that renders the IDE after confirming the project exists.
 */
function ValidProject({ projectId }: { projectId: string }) {
	return <IDEShell projectId={projectId} />;
}

/**
 * Auth gate — three-step check before rendering the app:
 *
 * 1. No session → Login page
 * 2. Session but no active org → Auto-select first org (personal org always exists)
 * 3. Session + active org → Render app
 *
 * Step 2 handles: first login (session created before org was set),
 * session re-creation after expiry, or any other path that leaves
 * activeOrganizationId null. The personal org is always created on
 * signup, so listOrganizations always returns at least one.
 */
function AuthGate() {
	const { data: session, isPending: sessionPending } = authClient.useSession();
	const { data: activeOrganization, isPending: organizationPending } = authClient.useActiveOrganization();
	const { data: organizations, isPending: listPending } = authClient.useListOrganizations();
	const settingOrganizationReference = useRef(false);
	const [organizationError, setOrganizationError] = useState<string | undefined>();

	// 4. Session exists but no active org — auto-select the first one.
	//    Uses a ref (not state) to track the in-flight request, avoiding
	//    synchronous setState inside the effect. When setActive completes,
	//    the better-auth hooks update activeOrganization, re-rendering this
	//    component and exiting the loading state naturally.
	const firstOrganizationId = organizations?.[0]?.id;

	useEffect(() => {
		if (!session || organizationPending || listPending || activeOrganization) return;
		if (settingOrganizationReference.current || !firstOrganizationId) return;
		settingOrganizationReference.current = true;
		void authClient.organization
			.setActive({ organizationId: firstOrganizationId })
			.then(({ error }) => {
				if (error) {
					setOrganizationError(error.message ?? 'Failed to set active organization.');
				}
			})
			.catch(() => {
				setOrganizationError('Failed to set active organization. Please reload the page.');
			})
			.finally(() => {
				settingOrganizationReference.current = false;
			});
	}, [session, organizationPending, listPending, activeOrganization, firstOrganizationId]);

	// 1. Still loading session
	if (sessionPending) {
		return <LoadingFallback />;
	}

	// 2. Not authenticated
	if (!session) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<LoginPage />
			</Suspense>
		);
	}

	// 3. Session exists but still loading org data
	if (organizationPending || listPending) {
		return <LoadingFallback />;
	}

	// 4. Error during org auto-selection
	if (organizationError) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg-primary">
				<div className="flex flex-col items-center gap-4 text-center">
					<p className="text-sm text-error">{organizationError}</p>
					<button
						onClick={() => globalThis.location.reload()}
						className={`
							cursor-pointer rounded-md bg-accent px-4 py-2 text-sm font-medium
							text-white
							hover:bg-accent-hover
						`}
					>
						Reload
					</button>
				</div>
			</div>
		);
	}

	// 5. Waiting for org auto-selection to complete
	if (!activeOrganization) {
		return <LoadingFallback />;
	}

	// 6. Fully authenticated with an active org
	return <AppContent />;
}

function AppContent() {
	const [projectId] = useState(getProjectIdFromUrl);

	if (hostType === 'app') {
		if (projectId) {
			return (
				<Suspense fallback={<LoadingFallback />}>
					<ProjectGate projectId={projectId} />
				</Suspense>
			);
		}

		const path = globalThis.location.pathname;
		if (path === '/' || path === '') {
			return (
				<Suspense fallback={<LoadingFallback />}>
					<DashboardPage />
				</Suspense>
			);
		}

		if (path === '/org') {
			return (
				<Suspense fallback={<LoadingFallback />}>
					<OrgManagementPage />
				</Suspense>
			);
		}

		return <NotFoundPage />;
	}

	return <NotFoundPage />;
}

// =============================================================================
// PWA Update Handler
// =============================================================================

function PwaUpdateHandler(): React.JSX.Element {
	usePwaUpdate();
	return <></>;
}

// =============================================================================
// Root App Component
// =============================================================================

export function App() {
	return (
		<ErrorBoundary fallback={ErrorFallback}>
			<QueryClientProvider client={queryClient}>
				<OfflineBanner />
				<AuthGate />
				<PwaUpdateHandler />
				<Toaster />
			</QueryClientProvider>
		</ErrorBoundary>
	);
}
