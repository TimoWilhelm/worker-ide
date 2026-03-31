/**
 * Organization-level constants.
 *
 * Numeric limits (max members, max organizations, etc.) are now
 * plan-based with entitlement overrides — see `shared/entitlements.ts`.
 * Only non-limit constants remain here.
 */

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
