/**
 * Preview secret fallback for test environments.
 *
 * In production, `PREVIEW_SECRET` is set via `wrangler secret put`.
 * Locally, it is loaded from `.dev.vars` (required — declared in
 * `wrangler.jsonc` under `secrets.required`).
 *
 * This fallback is only used in vitest worker tests where the Workers
 * runtime does not load `.dev.vars`. It must never be used in
 * production or local development.
 */
export const DEV_PREVIEW_SECRET = 'dev-preview-secret-unsafe-test-only';
