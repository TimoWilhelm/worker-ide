import { greet, capitalize } from '../src/utilities';

describe('greet', () => {
	it('greets by name', () => {
		expect(greet('World')).toBe('Hello, World!');
	});

	it('handles empty name', () => {
		expect(greet('')).toBe('Hello, !');
	});
});

describe('capitalize', () => {
	it('capitalizes the first letter', () => {
		expect(capitalize('hello')).toBe('Hello');
	});

	it('returns empty string for empty input', () => {
		expect(capitalize('')).toBe('');
	});

	it('does not change already capitalized strings', () => {
		expect(capitalize('Hello')).toBe('Hello');
	});
});
