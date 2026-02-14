/**
 * Unit tests for human-readable ID generator.
 */

import { describe, expect, it } from 'vitest';

import { generateHumanId } from './human-id';

describe('generateHumanId', () => {
	it('returns a string in adjective-noun-number format', () => {
		const id = generateHumanId();
		expect(id).toMatch(/^[a-z]+-[a-z]+-\d+$/);
	});

	it('has exactly three parts separated by hyphens', () => {
		const id = generateHumanId();
		const parts = id.split('-');
		expect(parts).toHaveLength(3);
	});

	it('has a number between 1 and 99', () => {
		for (let index = 0; index < 50; index++) {
			const id = generateHumanId();
			const number = Number.parseInt(id.split('-')[2], 10);
			expect(number).toBeGreaterThanOrEqual(1);
			expect(number).toBeLessThanOrEqual(99);
		}
	});

	it('generates different IDs across multiple calls', () => {
		const ids = new Set(Array.from({ length: 50 }, () => generateHumanId()));
		// With ~250K combinations, 50 calls should almost certainly be unique
		expect(ids.size).toBeGreaterThan(1);
	});
});
