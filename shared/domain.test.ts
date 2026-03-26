import { describe, expect, it } from 'vitest';

import { buildAppOrigin, buildPreviewOrigin, getBaseDomain, isPreviewOrigin, parseHost } from './domain';
import { fromHex } from './project-id';

const PROJECT_ID = fromHex('a'.repeat(64));
const VALID_TOKEN = 'a1b2c3d4e5f6'; // 12 lowercase hex chars

// -- parseHost ----------------------------------------------------------------

describe('parseHost', () => {
	describe('single-segment base (localhost)', () => {
		it('bare localhost → app', () => {
			const result = parseHost('localhost:3000');
			expect(result).toEqual({ type: 'app', baseDomain: 'localhost:3000' });
		});

		it('preview subdomain with token → preview with project ID and token', () => {
			const result = parseHost(`${PROJECT_ID}-${VALID_TOKEN}.preview.localhost:3000`);
			expect(result).toEqual({ type: 'preview', projectId: PROJECT_ID, token: VALID_TOKEN, baseDomain: 'localhost:3000' });
		});

		it('preview subdomain without token → unknown', () => {
			const result = parseHost(`${PROJECT_ID}.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('unknown subdomain → unknown', () => {
			const result = parseHost('foo.localhost:3000');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('old "app" subdomain → unknown', () => {
			const result = parseHost('app.localhost:3000');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});
	});

	describe('two-segment base (example.com)', () => {
		it('bare domain → app', () => {
			const result = parseHost('example.com');
			expect(result).toEqual({ type: 'app', baseDomain: 'example.com' });
		});

		it('preview subdomain with token → preview', () => {
			const result = parseHost(`${PROJECT_ID}-${VALID_TOKEN}.preview.example.com`);
			expect(result).toEqual({ type: 'preview', projectId: PROJECT_ID, token: VALID_TOKEN, baseDomain: 'example.com' });
		});

		it('preview subdomain without token → unknown', () => {
			const result = parseHost(`${PROJECT_ID}.preview.example.com`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'example.com' });
		});

		it('unknown subdomain → unknown', () => {
			const result = parseHost('random.example.com');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'example.com' });
		});
	});

	describe('token validation', () => {
		it('invalid token (too short) → unknown', () => {
			const result = parseHost(`${PROJECT_ID}-abc123.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('invalid token (too long) → unknown', () => {
			const result = parseHost(`${PROJECT_ID}-a1b2c3d4e5f6a7.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('invalid token (uppercase hex) → unknown', () => {
			const result = parseHost(`${PROJECT_ID}-A1B2C3D4E5F6.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('invalid token (non-hex chars) → unknown', () => {
			const result = parseHost(`${PROJECT_ID}-g1h2i3j4k5l6.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('no dash separator → unknown', () => {
			const result = parseHost(`${PROJECT_ID}${VALID_TOKEN}.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});
	});

	describe('edge cases', () => {
		it('empty string in preview position → unknown', () => {
			const result = parseHost('.preview.localhost:3000');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('dash only in preview position → unknown', () => {
			const result = parseHost(`-${VALID_TOKEN}.preview.localhost:3000`);
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('too many subdomain segments → unknown', () => {
			const result = parseHost('a.b.c.localhost:3000');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('bare host with fewer segments than expected → app', () => {
			const result = parseHost('localhost');
			expect(result).toEqual({ type: 'app', baseDomain: 'localhost' });
		});
	});
});

// -- getBaseDomain ------------------------------------------------------------

describe('getBaseDomain', () => {
	it('extracts base from bare localhost', () => {
		expect(getBaseDomain('localhost:3000')).toBe('localhost:3000');
	});

	it('extracts base from preview subdomain', () => {
		expect(getBaseDomain(`${PROJECT_ID}-${VALID_TOKEN}.preview.example.com`)).toBe('example.com');
	});
});

// -- buildAppOrigin -----------------------------------------------------------

describe('buildAppOrigin', () => {
	it('builds https origin by default', () => {
		expect(buildAppOrigin('example.com')).toBe('https://example.com');
	});

	it('builds http origin when specified', () => {
		expect(buildAppOrigin('localhost:3000', 'http:')).toBe('http://localhost:3000');
	});
});

// -- buildPreviewOrigin -------------------------------------------------------

describe('buildPreviewOrigin', () => {
	it('builds a preview origin with the project ID and token as subdomain', () => {
		const origin = buildPreviewOrigin(PROJECT_ID, VALID_TOKEN, 'localhost:3000', 'http:');
		expect(origin).toBe(`http://${PROJECT_ID}-${VALID_TOKEN}.preview.localhost:3000`);
	});

	it('uses https by default', () => {
		const origin = buildPreviewOrigin(PROJECT_ID, VALID_TOKEN, 'example.com');
		expect(origin).toBe(`https://${PROJECT_ID}-${VALID_TOKEN}.preview.example.com`);
	});

	it('produces a subdomain label that fits within DNS 63-char limit', () => {
		const origin = buildPreviewOrigin(PROJECT_ID, VALID_TOKEN, 'example.com');
		const url = new URL(origin);
		const firstLabel = url.hostname.split('.')[0];
		expect(firstLabel.length).toBeLessThanOrEqual(63);
	});
});

// -- isPreviewOrigin ----------------------------------------------------------

describe('isPreviewOrigin', () => {
	it('returns true for a valid preview origin', () => {
		expect(isPreviewOrigin(`http://${PROJECT_ID}-${VALID_TOKEN}.preview.localhost:3000`, 'localhost:3000')).toBe(true);
	});

	it('returns false for the app origin', () => {
		expect(isPreviewOrigin('http://localhost:3000', 'localhost:3000')).toBe(false);
	});

	it('returns false for a different base domain', () => {
		expect(isPreviewOrigin(`http://${PROJECT_ID}-${VALID_TOKEN}.preview.other.com`, 'localhost:3000')).toBe(false);
	});

	it('returns false for invalid URL', () => {
		expect(isPreviewOrigin('not-a-url', 'localhost:3000')).toBe(false);
	});

	it('returns false for preview subdomain without token', () => {
		expect(isPreviewOrigin(`http://${PROJECT_ID}.preview.localhost:3000`, 'localhost:3000')).toBe(false);
	});
});
