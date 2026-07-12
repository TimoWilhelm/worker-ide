import { describe, expect, it } from 'vitest';

import { buildArtifactUrl } from './build-artifact';

describe('buildArtifactUrl', () => {
	it('uses only immutable build inputs', () => {
		const url = new URL(buildArtifactUrl('vinext', 'preview', 'snapshot-hash'));
		expect(url.pathname).toBe('/build');
		expect(url.search).toBe('?format=v1&mode=preview&runtime=vinext&snapshot=snapshot-hash');
	});
});
