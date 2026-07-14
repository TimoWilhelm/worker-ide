import { describe, expect, it } from 'vitest';

import { isSupportedProofOfWork } from './cloudflare-temporary-account';

describe('isSupportedProofOfWork', () => {
	it('accepts the maximum proof-of-work difficulty supported by Wrangler', () => {
		expect(isSupportedProofOfWork(64_000, 1000)).toBe(true);
	});

	it('rejects proof-of-work difficulties above the supported limit', () => {
		expect(isSupportedProofOfWork(64_000_001, 1)).toBe(false);
	});
});
