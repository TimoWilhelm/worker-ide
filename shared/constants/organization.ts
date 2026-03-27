/**
 * Organization-level constants and limits.
 *
 * These are shared between frontend (for UI gating) and backend
 * (for server-side enforcement via better-auth plugin options).
 */

/**
 * Maximum number of organizations a single user can create.
 * The auto-created personal workspace counts toward this limit.
 */
export const MAX_ORGANIZATIONS_PER_USER = 5;

/**
 * Maximum number of members (including the owner) per organization.
 */
export const MAX_MEMBERS_PER_ORGANIZATION = 25;

/**
 * Maximum number of pending invitations per organization.
 */
export const MAX_PENDING_INVITATIONS_PER_ORGANIZATION = 25;

/**
 * Invitation expiry time in seconds.
 * Invitations that are not accepted within this window are automatically voided.
 * Default: 7 days.
 */
export const INVITATION_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * Maximum length for an organization name.
 */
export const MAX_ORGANIZATION_NAME_LENGTH = 50;

/**
 * Minimum length for an organization name.
 */
export const MIN_ORGANIZATION_NAME_LENGTH = 1;
