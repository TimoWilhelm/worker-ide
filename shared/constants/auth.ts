/**
 * Shared better-auth configuration constants.
 *
 * These values MUST stay in sync between the main app (worker-ide) and the
 * admin panel (worker-ide-admin). Both apps import from here so that a
 * change in one place is automatically reflected everywhere.
 *
 * App-specific concerns (social providers, org plugin, email hooks, database
 * hooks, analytics) remain in each app's own `createAuth` / `createAdminAuth`.
 */

// =============================================================================
// Auth paths
// =============================================================================

export const AUTH_BASE_PATH = '/api/auth';

// =============================================================================
// Admin plugin options (shared between main app & admin panel)
// =============================================================================

export const ADMIN_PLUGIN_OPTIONS = {
	defaultRole: 'user',
	bannedUserMessage: 'CONTACT_SUPPORT',
	impersonationSessionDuration: 15 * 60, // 15 minutes
} as const;

// =============================================================================
// Session / cookie-cache settings
// =============================================================================

export const SESSION_COOKIE_CACHE = {
	enabled: true,
	maxAge: 5 * 60, // 5 minutes
} as const;

// =============================================================================
// Advanced settings
// =============================================================================

export const IP_ADDRESS_HEADERS = ['cf-connecting-ip'] as const;
