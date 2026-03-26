/**
 * HMAC-signed time-bucket tokens for preview URLs.
 *
 * Preview URLs include a short HMAC token in the subdomain so that
 * direct links expire after a limited window. Tokens are derived from
 * a server-side secret and a one-hour time bucket:
 *
 *   token = HMAC-SHA256(secret, "projectId:bucket")[0:12]   (hex)
 *   bucket = floor(now_seconds / 3600)
 *
 * Validation accepts the **current** and **previous** bucket, giving
 * each token a 1–2 hour validity window depending on when it was issued.
 *
 * The token is 12 lowercase hex characters (48 bits). Combined with the
 * DNS label limit of 63 characters, this allows project IDs up to 50
 * characters: 50 (projectId) + 1 ("-") + 12 (token) = 63.
 */

/** Bucket duration in seconds (1 hour). */
const BUCKET_SIZE_SECONDS = 3600;

/** Number of hex characters kept from the HMAC digest (48 bits). */
export const TOKEN_HEX_LENGTH = 12;

/** Pattern that matches a valid preview token (12 lowercase hex chars). */
export const PREVIEW_TOKEN_PATTERN = /^[\da-f]{12}$/;

// -- Time buckets -------------------------------------------------------------

/** Return the current time-bucket index. */
export function currentBucket(): number {
	return Math.floor(Date.now() / 1000 / BUCKET_SIZE_SECONDS);
}

// -- HMAC helpers -------------------------------------------------------------

/**
 * Compute HMAC-SHA256 of `message` using `secret` and return the full
 * hex-encoded digest string.
 */
async function hmacHex(secret: string, message: string): Promise<string> {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
	const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
	return [...new Uint8Array(signature)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison.
 *
 * XOR-based comparison that always examines every character, preventing
 * timing side-channels. Returns `false` for different-length strings
 * (the length itself leaks, but our tokens are always fixed-length).
 */
export function constantTimeEqual(a: string, b: string): boolean {
	if (a.length !== b.length) return false;
	let mismatch = 0;
	for (let index = 0; index < a.length; index++) {
		// eslint-disable-next-line unicorn/prefer-code-point
		mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
	}
	return mismatch === 0;
}

// -- Public API ---------------------------------------------------------------

/**
 * Generate a preview token for the current time bucket.
 *
 * Returns the first {@link TOKEN_HEX_LENGTH} hex characters of
 * `HMAC-SHA256(secret, "projectId:bucket")`.
 */
export async function generatePreviewToken(projectId: string, secret: string): Promise<string> {
	const bucket = currentBucket();
	const mac = await hmacHex(secret, `${projectId}:${bucket}`);
	return mac.slice(0, TOKEN_HEX_LENGTH);
}

/**
 * Validate a preview token against the current and previous time bucket.
 *
 * Accepts both the current bucket and the immediately preceding one so
 * that tokens remain valid for 1–2 hours regardless of when they were
 * issued within a bucket.
 */
export async function validatePreviewToken(projectId: string, token: string, secret: string): Promise<boolean> {
	if (!PREVIEW_TOKEN_PATTERN.test(token)) return false;

	const bucket = currentBucket();

	const currentMac = await hmacHex(secret, `${projectId}:${bucket}`);
	if (constantTimeEqual(currentMac.slice(0, TOKEN_HEX_LENGTH), token)) return true;

	const previousMac = await hmacHex(secret, `${projectId}:${bucket - 1}`);
	if (constantTimeEqual(previousMac.slice(0, TOKEN_HEX_LENGTH), token)) return true;

	return false;
}
