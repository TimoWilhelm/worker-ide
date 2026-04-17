export const AUTH_BASE_PATH = '/api/auth';

export const ADMIN_PLUGIN_OPTIONS = {
	defaultRole: 'user',
	bannedUserMessage: 'CONTACT_SUPPORT',
	impersonationSessionDuration: 15 * 60, // 15 minutes
} as const;

export const SESSION_COOKIE_CACHE = {
	enabled: true,
	maxAge: 5 * 60, // 5 minutes
} as const;

export const IP_ADDRESS_HEADERS = ['cf-connecting-ip'] as const;
