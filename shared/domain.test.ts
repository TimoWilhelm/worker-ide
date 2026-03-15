import { describe, expect, it } from 'vitest';

import { buildAppOrigin, buildPreviewOrigin, getBaseDomain, isPreviewOrigin, parseHost } from './domain';
import { fromHex } from './project-id';

const PROJECT_ID = fromHex('a'.repeat(64));

// -- parseHost ----------------------------------------------------------------

describe('parseHost', () => {
	describe('single-segment base (localhost)', () => {
		it('bare localhost → app', () => {
			const result = parseHost('localhost:3000');
			expect(result).toEqual({ type: 'app', baseDomain: 'localhost:3000' });
		});

		it('preview subdomain → preview with project ID', () => {
			const result = parseHost(`${PROJECT_ID}.preview.localhost:3000`);
			expect(result).toEqual({ type: 'preview', projectId: PROJECT_ID, baseDomain: 'localhost:3000' });
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

		it('preview subdomain → preview', () => {
			const result = parseHost(`${PROJECT_ID}.preview.example.com`);
			expect(result).toEqual({ type: 'preview', projectId: PROJECT_ID, baseDomain: 'example.com' });
		});

		it('unknown subdomain → unknown', () => {
			const result = parseHost('random.example.com');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'example.com' });
		});
	});

	describe('edge cases', () => {
		it('empty string in preview position → unknown', () => {
			const result = parseHost('.preview.localhost:3000');
			expect(result).toEqual({ type: 'unknown', baseDomain: 'localhost:3000' });
		});

		it('overly long ID in preview position → unknown', () => {
			const result = parseHost(`${'a'.repeat(51)}.preview.localhost:3000`);
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
		expect(getBaseDomain(`${PROJECT_ID}.preview.example.com`)).toBe('example.com');
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
	it('builds a preview origin with the project ID as subdomain', () => {
		const origin = buildPreviewOrigin(PROJECT_ID, 'localhost:3000', 'http:');
		expect(origin).toBe(`http://${PROJECT_ID}.preview.localhost:3000`);
	});

	it('uses https by default', () => {
		const origin = buildPreviewOrigin(PROJECT_ID, 'example.com');
		expect(origin).toBe(`https://${PROJECT_ID}.preview.example.com`);
	});
});

// -- isPreviewOrigin ----------------------------------------------------------

describe('isPreviewOrigin', () => {
	it('returns true for a valid preview origin', () => {
		expect(isPreviewOrigin(`http://${PROJECT_ID}.preview.localhost:3000`, 'localhost:3000')).toBe(true);
	});

	it('returns false for the app origin', () => {
		expect(isPreviewOrigin('http://localhost:3000', 'localhost:3000')).toBe(false);
	});

	it('returns false for a different base domain', () => {
		expect(isPreviewOrigin(`http://${PROJECT_ID}.preview.other.com`, 'localhost:3000')).toBe(false);
	});

	it('returns false for invalid URL', () => {
		expect(isPreviewOrigin('not-a-url', 'localhost:3000')).toBe(false);
	});
});
