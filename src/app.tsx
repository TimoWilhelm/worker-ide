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
import { Suspense, use, useEffect, useState } from 'react';

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
import { AccountPage, AppearancePage, ProfilePage, SettingsLayout } from '@/features/settings';
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
 * localStorage key for remembering the last-visited org slug.
 * Used by the `/` redirect to take the user back to their last org.
 */
const LAST_ORG_SLUG_KEY = 'lastOrgSlug';

/**
 * Redirect component — navigates via useEffect so react-compiler is happy.
 * Defined outside AppContent to avoid react-compiler "forbidden write" errors.
 */
function Redirect({ to }: { to: string }) {
	useEffect(() => {
		globalThis.location.href = to;
	}, [to]);
	return <LoadingFallback />;
}

/**
 * Parse the current URL for org-scoped routes.
 * Returns the org slug and optional sub-path (e.g. "settings").
 */
function parseOrgRoute(): { orgSlug: string; subPath: string } | undefined {
	const match = globalThis.location.pathname.match(/^\/org\/([^/]+)(\/.*)?$/);
	if (match) {
		return { orgSlug: match[1], subPath: match[2] ?? '' };
	}
	return undefined;
}

/**
 * Auth gate — simplified flow without session-stored active org:
 *
 * 1. No session -> Login page
 * 2. Session exists -> fetch org list
 * 3. 0 orgs -> redirect to /create-org
 * 4. Has orgs -> URL-based routing
 */
function AuthGate() {
	const { data: session, isPending: sessionPending } = authClient.useSession();
	const { data: organizations, isPending: listPending } = authClient.useListOrganizations();
	const { data: activeOrganization } = authClient.useActiveOrganization();

	if (sessionPending) {
		return <LoadingFallback />;
	}

	if (!session) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<LoginPage />
			</Suspense>
		);
	}

	if (listPending) {
		return <LoadingFallback />;
	}

	const user = {
		name: session.user.name,
		email: session.user.email,
		image: session.user.image ?? undefined,
		emailVerified: session.user.emailVerified,
	};
	return <AppContent organizations={organizations ?? []} user={user} activeOrganizationId={activeOrganization?.id} />;
}

interface OrganizationEntry {
	id: string;
	name: string;
	slug: string | null;
	plan?: string;
}

interface UserInfo {
	name: string;
	email: string;
	image?: string;
	emailVerified?: boolean;
}

function AppContent({
	organizations,
	user,
	activeOrganizationId,
}: {
	organizations: OrganizationEntry[];
	user: UserInfo;
	activeOrganizationId?: string;
}) {
	const [projectId] = useState(getProjectIdFromUrl);

	if (hostType !== 'app') {
		return <NotFoundPage />;
	}

	// Project IDE route — org not needed in URL
	if (projectId) {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<ProjectGate projectId={projectId} />
			</Suspense>
		);
	}

	const path = globalThis.location.pathname;

	// 0 orgs — force user to create an org before doing anything else.
	// Only the /create-org page is accessible; all other paths redirect here.
	if (organizations.length === 0) {
		if (path !== '/create-org') {
			return <Redirect to="/create-org" />;
		}
		return (
			<Suspense fallback={<LoadingFallback />}>
				<DashboardPage orgSlug="" organizationId="" organizations={organizations} isCreateOrgMode user={user} />
			</Suspense>
		);
	}

	// Create org page (user has orgs but wants to create another)
	if (path === '/create-org') {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<DashboardPage orgSlug="" organizationId="" organizations={organizations} isCreateOrgMode user={user} />
			</Suspense>
		);
	}

	// User settings routes: /settings, /settings/profile, /settings/account
	if (path === '/settings') {
		return <Redirect to="/settings/profile" />;
	}
	if (path === '/settings/profile') {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<SettingsLayout activePath="/settings/profile">
					<ProfilePage user={user} />
				</SettingsLayout>
			</Suspense>
		);
	}
	if (path === '/settings/account') {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<SettingsLayout activePath="/settings/account">
					<AccountPage />
				</SettingsLayout>
			</Suspense>
		);
	}
	if (path === '/settings/appearance') {
		return (
			<Suspense fallback={<LoadingFallback />}>
				<SettingsLayout activePath="/settings/appearance">
					<AppearancePage />
				</SettingsLayout>
			</Suspense>
		);
	}

	// Root redirect: / -> /org/:slug
	// Priority: 1) session activeOrganizationId  2) localStorage  3) first org
	if (path === '/' || path === '') {
		const activeOrg = activeOrganizationId ? organizations.find((o) => o.id === activeOrganizationId) : undefined;
		const lastSlug = globalThis.localStorage.getItem(LAST_ORG_SLUG_KEY);
		const lastOrg = lastSlug ? organizations.find((o) => o.slug === lastSlug) : undefined;
		const targetOrg = activeOrg ?? lastOrg ?? organizations[0];
		const slug = targetOrg.slug ?? targetOrg.id;
		return <Redirect to={`/org/${slug}`} />;
	}

	// Org-scoped routes: /org/:orgSlug and /org/:orgSlug/settings
	const orgRoute = parseOrgRoute();
	if (orgRoute) {
		const organization = organizations.find((o) => o.slug === orgRoute.orgSlug || o.id === orgRoute.orgSlug);
		if (!organization) {
			return <NotFoundPage />;
		}

		// Remember last visited org
		if (organization.slug) {
			globalThis.localStorage.setItem(LAST_ORG_SLUG_KEY, organization.slug);
		}

		if (orgRoute.subPath === '/settings') {
			return (
				<Suspense fallback={<LoadingFallback />}>
					<OrgManagementPage orgSlug={orgRoute.orgSlug} organizationId={organization.id} organizations={organizations} />
				</Suspense>
			);
		}

		// Dashboard
		return (
			<Suspense fallback={<LoadingFallback />}>
				<DashboardPage orgSlug={orgRoute.orgSlug} organizationId={organization.id} organizations={organizations} user={user} />
			</Suspense>
		);
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
