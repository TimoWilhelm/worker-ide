import type { ProjectFilesystem } from './durable/project-filesystem';

interface AuthVariables {
	session: { id: string; userId: string; updateActivity: boolean; collaborationVisible: boolean };
}

/**
 * Hono environment for routes that only require authentication (no project context).
 * Used by root-level API routes like /api/new-project, /api/org/*.
 */
export interface AuthedEnvironment {
	Bindings: Env;
	Variables: AuthVariables;
}

/**
 * Hono app environment type with auth + project-scoped variables.
 * Used by all /p/:projectId/api/* route handlers.
 */
export interface AppEnvironment {
	Bindings: Env;
	Variables: AuthVariables & {
		projectId: string;
		projectRoot: string;
		fsStub: DurableObjectStub<ProjectFilesystem>;
	};
}
