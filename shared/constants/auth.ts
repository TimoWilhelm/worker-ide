/**
 * Shared better-auth configuration constants.
 */

// =============================================================================
// Auth paths
// =============================================================================

export const AUTH_BASE_PATH = '/api/auth';

// =============================================================================
// Admin plugin options
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
