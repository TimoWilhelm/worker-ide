/**
 * Project-level constants for the Worker IDE application.
 */

/**
 * Number of days since creation after which an unused project is auto soft-deleted
 * by the daily cron job.
 */
export const PROJECT_INACTIVITY_DAYS = 365;

/**
 * Number of days after soft-delete before a project is permanently purged.
 */
export const SOFT_DELETE_RETENTION_DAYS = 30;

/**
 * Maximum number of active (non-deleted) projects per organization.
 */
export const MAX_PROJECTS_PER_ORGANIZATION = 50;

/**
 * Maximum length for a project name.
 */
export const MAX_PROJECT_NAME_LENGTH = 60;

/**
 * Maximum number of AI sessions retained per project.
 * Older sessions beyond this limit are pruned automatically.
 */
export const MAX_AI_SESSIONS_PER_PROJECT = 50;
