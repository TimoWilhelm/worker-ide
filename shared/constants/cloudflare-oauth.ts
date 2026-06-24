/**
 * Cloudflare self-managed OAuth configuration.
 *
 * Used to let a user authorize the IDE to deploy Workers into their own
 * Cloudflare account, replacing the legacy "paste an API token" flow.
 *
 * Endpoints come from Cloudflare's OIDC discovery document:
 *   https://dash.cloudflare.com/.well-known/openid-configuration
 */

export const CLOUDFLARE_OAUTH_AUTHORIZE_URL = 'https://dash.cloudflare.com/oauth2/auth';
export const CLOUDFLARE_OAUTH_TOKEN_URL = 'https://dash.cloudflare.com/oauth2/token';
export const CLOUDFLARE_OAUTH_REVOKE_URL = 'https://dash.cloudflare.com/oauth2/revoke';
export const CLOUDFLARE_OAUTH_USERINFO_URL = 'https://dash.cloudflare.com/oauth2/userinfo';

/** Cloudflare REST API base used for deploy + account-listing calls. */
export const CLOUDFLARE_API_BASE = 'https://api.cloudflare.com/client/v4';

/**
 * OAuth scopes requested during consent. Scope IDs map 1:1 to Cloudflare API
 * token permission names (fetched from `/oauth/scopes`).
 *
 * - `workers-scripts.write` — upload Worker scripts + enable workers.dev subdomain
 * - `workers-r2.write`      — create/list R2 buckets for the `STORAGE` binding
 * - `memberships.read`      — list the accounts the user can deploy to (account picker)
 * - `offline_access`        — receive a refresh token so deploys keep working
 *                             after the short-lived access token expires
 */
export const CLOUDFLARE_OAUTH_SCOPES = ['workers-scripts.write', 'workers-r2.write', 'memberships.read', 'offline_access'] as const;

/** Path (relative to the app origin) that Cloudflare redirects back to after consent. */
export const CLOUDFLARE_OAUTH_CALLBACK_PATH = '/api/cloudflare/oauth/callback';

/** Refresh the access token this many seconds before it actually expires. */
export const CLOUDFLARE_OAUTH_REFRESH_LEEWAY_SECONDS = 60;

/** Name of the short-lived HttpOnly cookie holding the in-flight PKCE/state payload. */
export const CLOUDFLARE_OAUTH_STATE_COOKIE = 'cf_oauth_state';

/** TTL for the in-flight authorization cookie. */
export const CLOUDFLARE_OAUTH_STATE_TTL_SECONDS = 600;
