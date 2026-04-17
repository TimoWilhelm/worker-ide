import { fetchProjectMeta } from '@/lib/api-client';
import { ApiError } from '@/lib/api-error';

/**
 * Tri-state result for project access checks.
 * - 'exists': project is accessible
 * - 'not-found': project does not exist or was deleted
 * - 'forbidden': project or its org has been restricted
 */
export type ProjectAccessStatus = 'exists' | 'not-found' | 'forbidden';

/**
 * Cache of project access check promises, keyed by projectId.
 * Prevents duplicate fetches when React re-renders during Suspense.
 * Non-success results are evicted after a short TTL so a page refresh
 * can detect a project that was created or un-restricted after the initial check.
 */
const projectAccessCache = new Map<string, Promise<ProjectAccessStatus>>();
const NOT_FOUND_TTL_MS = 30_000;
const FORBIDDEN_TTL_MS = 60_000;

export function checkProjectAccess(projectId: string): Promise<ProjectAccessStatus> {
	let promise = projectAccessCache.get(projectId);
	if (!promise) {
		promise = fetchProjectMeta(projectId)
			.then((): ProjectAccessStatus => 'exists')
			.catch((error: unknown): ProjectAccessStatus => {
				if (error instanceof ApiError) {
					if (error.status === 403) return 'forbidden';
					if (error.status === 404) return 'not-found';
				}
				// Evict rejected promise so the user can retry via the ErrorBoundary
				projectAccessCache.delete(projectId);
				// Network errors, 401s, 5xxs — re-throw so ErrorBoundary handles them
				throw error;
			})
			.then((status) => {
				if (status !== 'exists') {
					const ttl = status === 'forbidden' ? FORBIDDEN_TTL_MS : NOT_FOUND_TTL_MS;
					setTimeout(() => projectAccessCache.delete(projectId), ttl);
				}
				return status;
			});
		projectAccessCache.set(projectId, promise);
	}
	return promise;
}
