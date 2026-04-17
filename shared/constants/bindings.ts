/**
 * The binding name exposed in the user worker's `env` object.
 * This name is the same in both the IDE sandbox and after deployment.
 */
export const STORAGE_BINDING_NAME = 'STORAGE';

/**
 * Key prefix used in the shared R2 bucket to scope objects per project.
 * Each project's objects are stored under `projects/{projectId}/`.
 */
export const STORAGE_KEY_PREFIX = 'projects/';
