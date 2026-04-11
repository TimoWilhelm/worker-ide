/**
 * Tests for the API rate limit middleware.
 *
 * Runs in the workerd test pool via @cloudflare/vitest-pool-workers
 * so that `env` from `cloudflare:workers` is available.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

describe('API_RATE_LIMITER binding', () => {
	it('is available in the test environment', () => {
		expect(env.API_RATE_LIMITER).toBeDefined();
	});

	it('allows requests under the limit', async () => {
		const result = await env.API_RATE_LIMITER.limit({ key: 'test-user-allow' });
		expect(result.success).toBe(true);
	});
});
