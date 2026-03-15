import { describe, expect, it } from 'vitest';

import { fromHex, isValidProjectId, PROJECT_ID_PATTERN, toHex } from './project-id';

const HEX_ID = 'a'.repeat(64);
const PROJECT_ID = fromHex(HEX_ID);

describe('fromHex / toHex', () => {
	it('round-trips a hex ID', () => {
		expect(toHex(fromHex(HEX_ID))).toBe(HEX_ID);
	});

	it('produces a string matching PROJECT_ID_PATTERN', () => {
		expect(PROJECT_ID).toMatch(PROJECT_ID_PATTERN);
	});

	it('produces a string ≤50 chars', () => {
		expect(PROJECT_ID.length).toBeLessThanOrEqual(50);
	});

	it('produces different IDs for different hex IDs', () => {
		expect(fromHex('b'.repeat(64))).not.toBe(PROJECT_ID);
	});

	it('round-trips the max hex value', () => {
		const maxHex = 'f'.repeat(64);
		expect(toHex(fromHex(maxHex))).toBe(maxHex);
	});

	it('round-trips a small hex value with leading zeros', () => {
		const smallHex = '0'.repeat(63) + '1';
		expect(toHex(fromHex(smallHex))).toBe(smallHex);
	});
});

describe('isValidProjectId', () => {
	it('accepts a valid project ID', () => {
		expect(isValidProjectId(PROJECT_ID)).toBe(true);
	});

	it('rejects an empty string', () => {
		expect(isValidProjectId('')).toBe(false);
	});

	it('rejects strings longer than 50 chars', () => {
		expect(isValidProjectId('a'.repeat(51))).toBe(false);
	});

	it('rejects uppercase characters', () => {
		expect(isValidProjectId('ABCDEF')).toBe(false);
	});

	it('rejects strings with special characters', () => {
		expect(isValidProjectId('abc-def')).toBe(false);
	});

	it('accepts single-character IDs that decode to valid hex', () => {
		expect(isValidProjectId('1')).toBe(true);
	});
});

describe('PROJECT_ID_PATTERN', () => {
	it('matches lowercase alphanumeric strings', () => {
		expect(PROJECT_ID_PATTERN.test('abc123')).toBe(true);
	});

	it('does not match uppercase', () => {
		expect(PROJECT_ID_PATTERN.test('ABC')).toBe(false);
	});

	it('does not match strings with hyphens', () => {
		expect(PROJECT_ID_PATTERN.test('abc-def')).toBe(false);
	});

	it('does not match empty strings', () => {
		expect(PROJECT_ID_PATTERN.test('')).toBe(false);
	});
});
