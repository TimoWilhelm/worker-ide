export interface AuthErrorInfo {
	title: string;
	message: string;
}

/**
 * All Better Auth redirect error codes mapped to user-facing messages.
 *
 * These errors occur during OAuth callback processing and cause a redirect
 * to `/?error=<code>` or `/settings/profile?error=<code>`.
 */
const AUTH_ERROR_MESSAGES: Record<string, AuthErrorInfo> = {
	// ── Account linking / identity conflicts ──────────────────────────────

	unable_to_link_account: {
		title: 'Unable to Link Account',
		message:
			'This account could not be linked. The provider may not have verified your email address. Try signing in with the provider you originally used.',
	},

	account_already_linked_to_different_user: {
		title: 'Account Already Linked',
		message:
			'This social account is already connected to a different user. Unlink it from the other account first, or sign in with a different provider.',
	},

	"email_doesn't_match": {
		title: 'Email Mismatch',
		message:
			"The email from this provider doesn't match your account email. Sign into the provider with the same email, or link the account from your profile settings.",
	},

	email_not_found: {
		title: 'Email Not Available',
		message:
			'The provider did not share your email address. Check your provider privacy settings to ensure email access is allowed, then try again.',
	},

	// ── OAuth flow / infrastructure errors ────────────────────────────────

	state_mismatch: {
		title: 'Session Expired',
		message:
			'Your sign-in session expired or cookies were blocked. Please try again. If this persists, check that third-party cookies are enabled in your browser.',
	},

	state_not_found: {
		title: 'Sign-In Session Not Found',
		message:
			'The sign-in session could not be found. This can happen if you navigated directly to the callback URL. Please start the sign-in process again.',
	},

	no_code: {
		title: 'Authorization Denied',
		message: 'The sign-in was not completed. You may have denied access or the request was interrupted. Please try again.',
	},

	invalid_callback_request: {
		title: 'Invalid Sign-In Request',
		message: 'The sign-in callback was malformed. Please try signing in again. If the problem persists, try a different browser.',
	},

	no_callback_url: {
		title: 'Sign-In Configuration Error',
		message: 'The sign-in flow was misconfigured. Please try again.',
	},

	oauth_provider_not_found: {
		title: 'Provider Not Available',
		message: 'The requested sign-in provider is not configured. Please use one of the available sign-in options.',
	},

	unable_to_get_user_info: {
		title: 'Could Not Retrieve Profile',
		message: "We couldn't get your profile information from the provider. This is usually temporary — please try again in a moment.",
	},

	// ── Access control ────────────────────────────────────────────────────

	signup_disabled: {
		title: 'Sign-Up Disabled',
		message:
			'New account registration is currently disabled. If you already have an account, try signing in with the provider you originally used.',
	},
};

/**
 * Look up user-friendly error info for a known Better Auth error code.
 *
 * Returns `undefined` when the code is falsy **or** not recognized.
 */
export function getAuthErrorInfo(errorCode: string | undefined): AuthErrorInfo | undefined {
	if (!errorCode) return undefined;

	return AUTH_ERROR_MESSAGES[errorCode];
}
