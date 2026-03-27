import type { RepoDurableObject } from '@git/do/index';

/**
 * Get the Durable Object stub for a repository.
 * @param env - Git worker environment bindings
 * @param repoId - Repository identifier (e.g. "ide/projectId")
 * @returns DurableObjectStub for the specified repository
 */
export function getRepoStub(environment: GitWorkerEnvironment, repoId: string): DurableObjectStub<RepoDurableObject> {
	const id = environment.REPO_DO.idFromName(repoId);
	return environment.REPO_DO.get(id);
}
