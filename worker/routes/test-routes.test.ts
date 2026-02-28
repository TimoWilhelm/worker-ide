/**
 * Unit tests for test-routes utility functions.
 */

import { describe, expect, it } from 'vitest';

import { parseTestNames } from './test-routes';

// =============================================================================
// parseTestNames
// =============================================================================

describe('parseTestNames', () => {
	it('parses a single top-level it()', () => {
		const source = `it('adds numbers', () => { expect(1+1).toBe(2); });`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([{ name: 'adds numbers', suiteName: '(top-level)' }]);
	});

	it('parses a single top-level test()', () => {
		const source = `test('adds numbers', () => { expect(1+1).toBe(2); });`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([{ name: 'adds numbers', suiteName: '(top-level)' }]);
	});

	it('parses it() inside a describe()', () => {
		const source = `
describe('math', () => {
  it('adds', () => {});
  it('subtracts', () => {});
});`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([
			{ name: 'adds', suiteName: 'math' },
			{ name: 'subtracts', suiteName: 'math' },
		]);
	});

	it('parses multiple describe blocks', () => {
		const source = `
describe('math', () => {
  it('adds', () => {});
});
describe('string', () => {
  it('trims', () => {});
});`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([
			{ name: 'adds', suiteName: 'math' },
			{ name: 'trims', suiteName: 'string' },
		]);
	});

	it('handles double-quoted strings', () => {
		const source = `describe("math", () => { it("adds", () => {}); });`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([{ name: 'adds', suiteName: 'math' }]);
	});

	it('handles backtick-quoted strings', () => {
		const source = 'describe(`math`, () => { it(`adds`, () => {}); });';
		const tests = parseTestNames(source);

		expect(tests).toEqual([{ name: 'adds', suiteName: 'math' }]);
	});

	it('handles mixed quote styles', () => {
		const source = `
describe('math', () => {
  it("adds", () => {});
  test(\`subtracts\`, () => {});
});`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([
			{ name: 'adds', suiteName: 'math' },
			{ name: 'subtracts', suiteName: 'math' },
		]);
	});

	it('returns empty array for a file with no tests', () => {
		const source = `export function add(a, b) { return a + b; }`;
		const tests = parseTestNames(source);

		expect(tests).toEqual([]);
	});

	it('returns empty array for an empty string', () => {
		const tests = parseTestNames('');
		expect(tests).toEqual([]);
	});

	it('assigns tests after a describe to that describe (position heuristic)', () => {
		const source = `
describe('suite A', () => {
  it('test 1', () => {});
});

describe('suite B', () => {
  it('test 2', () => {});
});

it('test 3', () => {});`;
		const tests = parseTestNames(source);

		// test 3 appears after suite B, so the heuristic assigns it to suite B
		expect(tests).toEqual([
			{ name: 'test 1', suiteName: 'suite A' },
			{ name: 'test 2', suiteName: 'suite B' },
			{ name: 'test 3', suiteName: 'suite B' },
		]);
	});

	it('does not match partial words like "described" or "testing"', () => {
		const source = `
const described = 'something';
const testing = true;
it('real test', () => {});`;
		const tests = parseTestNames(source);

		expect(tests).toHaveLength(1);
		expect(tests[0].name).toBe('real test');
	});
});
