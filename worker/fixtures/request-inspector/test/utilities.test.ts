import { formatBytes, parseHeaderList, maskSensitiveValue } from '../src/utilities';

describe('formatBytes', () => {
	it('formats zero bytes', () => {
		expect(formatBytes(0)).toBe('0 B');
	});

	it('formats bytes', () => {
		expect(formatBytes(500)).toBe('500 B');
	});

	it('formats kilobytes', () => {
		expect(formatBytes(1024)).toBe('1 KB');
	});

	it('formats megabytes', () => {
		expect(formatBytes(1_048_576)).toBe('1 MB');
	});

	it('respects decimal precision', () => {
		expect(formatBytes(1536, 1)).toBe('1.5 KB');
	});
});

describe('parseHeaderList', () => {
	it('parses comma-separated values', () => {
		expect(parseHeaderList('gzip, deflate, br')).toEqual(['gzip', 'deflate', 'br']);
	});

	it('returns empty array for empty string', () => {
		expect(parseHeaderList('')).toEqual([]);
	});

	it('trims whitespace', () => {
		expect(parseHeaderList('  a , b , c  ')).toEqual(['a', 'b', 'c']);
	});
});

describe('maskSensitiveValue', () => {
	it('masks long values', () => {
		expect(maskSensitiveValue('Bearer abc123token')).toBe('Bear****');
	});

	it('fully masks short values', () => {
		expect(maskSensitiveValue('abc')).toBe('****');
	});

	it('respects custom visible char count', () => {
		expect(maskSensitiveValue('secretvalue', 6)).toBe('secret****');
	});
});
