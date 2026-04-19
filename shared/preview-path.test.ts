import { describe, expect, it } from 'vitest';

import { toAbsolutePreviewPath } from './preview-path';

describe('toAbsolutePreviewPath', () => {
	it('preserves absolute preview paths', () => {
		expect(toAbsolutePreviewPath('/src/style.css')).toBe('/src/style.css');
	});

	it('normalizes relative preview paths to absolute ones', () => {
		expect(toAbsolutePreviewPath('src/style.css')).toBe('/src/style.css');
	});

	it('returns the preview root for empty paths', () => {
		expect(toAbsolutePreviewPath('')).toBe('/');
	});
});
