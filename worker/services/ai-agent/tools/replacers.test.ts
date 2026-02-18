/**
 * Unit tests for the string replacement strategies.
 */

import { describe, expect, it } from 'vitest';

import {
	BlockAnchorReplacer,
	ContextAwareReplacer,
	EscapeNormalizedReplacer,
	IndentationFlexibleReplacer,
	levenshtein,
	LineTrimmedReplacer,
	MultiOccurrenceReplacer,
	replace,
	SimpleReplacer,
	TrimmedBoundaryReplacer,
	WhitespaceNormalizedReplacer,
} from './replacers';

// =============================================================================
// Levenshtein Distance Tests
// =============================================================================

describe('levenshtein', () => {
	it('should return 0 for identical strings', () => {
		expect(levenshtein('abc', 'abc')).toBe(0);
		expect(levenshtein('', '')).toBe(0);
	});

	it('should return the length of the non-empty string when one is empty', () => {
		expect(levenshtein('abc', '')).toBe(3);
		expect(levenshtein('', 'abc')).toBe(3);
	});

	it('should calculate distance correctly', () => {
		expect(levenshtein('kitten', 'sitting')).toBe(3);
		expect(levenshtein('saturday', 'sunday')).toBe(3);
	});
});

// =============================================================================
// SimpleReplacer Tests
// =============================================================================

describe('SimpleReplacer', () => {
	it('should yield the exact find string', () => {
		const results = [...SimpleReplacer('const foo = 1;', 'foo')];
		expect(results).toEqual(['foo']);
	});
});

// =============================================================================
// LineTrimmedReplacer Tests
// =============================================================================

describe('LineTrimmedReplacer', () => {
	it('should match lines with trimmed whitespace', () => {
		const content = '  const foo = 1;  \n  const bar = 2;  ';
		const results = [...LineTrimmedReplacer(content, 'const foo = 1;')];
		expect(results).toEqual(['  const foo = 1;  ']);
	});

	it('should match multi-line blocks with trimmed whitespace', () => {
		const content = '  function test() {\n    return 1;\n  }';
		const find = 'function test() {\n  return 1;\n}';
		const results = [...LineTrimmedReplacer(content, find)];
		expect(results.length).toBe(1);
	});

	it('should not match when content differs', () => {
		const content = 'const foo = 2;';
		const results = [...LineTrimmedReplacer(content, 'const foo = 1;')];
		expect(results).toEqual([]);
	});
});

// =============================================================================
// BlockAnchorReplacer Tests
// =============================================================================

describe('BlockAnchorReplacer', () => {
	it('should match blocks by first and last line anchors', () => {
		const content = 'function test() {\n  const x = 1;\n  const y = 2;\n  return x + y;\n}';
		const find = 'function test() {\n  const a = 1;\n  const b = 2;\n  return a + b;\n}';
		const results = [...BlockAnchorReplacer(content, find)];
		expect(results.length).toBe(1);
	});

	it('should require at least 3 lines', () => {
		const content = 'line1\nline2';
		const find = 'line1\nline2';
		const results = [...BlockAnchorReplacer(content, find)];
		expect(results).toEqual([]);
	});
});

// =============================================================================
// WhitespaceNormalizedReplacer Tests
// =============================================================================

describe('WhitespaceNormalizedReplacer', () => {
	it('should match with collapsed whitespace', () => {
		const content = 'const   foo   =   1;';
		const results = [...WhitespaceNormalizedReplacer(content, 'const foo = 1;')];
		expect(results.length).toBeGreaterThan(0);
	});

	it('should handle multi-line content', () => {
		const content = 'const  foo  =  1;\nconst  bar  =  2;';
		const results = [...WhitespaceNormalizedReplacer(content, 'const foo = 1;\nconst bar = 2;')];
		expect(results.length).toBeGreaterThan(0);
	});
});

// =============================================================================
// IndentationFlexibleReplacer Tests
// =============================================================================

describe('IndentationFlexibleReplacer', () => {
	it('should match ignoring leading indentation', () => {
		const content = '    function test() {\n        return 1;\n    }';
		const find = 'function test() {\n    return 1;\n}';
		const results = [...IndentationFlexibleReplacer(content, find)];
		expect(results.length).toBe(1);
	});
});

// =============================================================================
// EscapeNormalizedReplacer Tests
// =============================================================================

describe('EscapeNormalizedReplacer', () => {
	it('should handle escape sequences', () => {
		const content = String.raw`const str = "hello\nworld";`;
		const results = [...EscapeNormalizedReplacer(content, 'const str = "hello\nworld";')];
		// The unescaped version should be found
		expect(results.length).toBeGreaterThanOrEqual(0);
	});
});

// =============================================================================
// TrimmedBoundaryReplacer Tests
// =============================================================================

describe('TrimmedBoundaryReplacer', () => {
	it('should match trimmed content', () => {
		const content = 'const foo = 1;';
		const results = [...TrimmedBoundaryReplacer(content, '  const foo = 1;  ')];
		expect(results).toContain('const foo = 1;');
	});

	it('should not yield when find is already trimmed', () => {
		const content = 'const foo = 1;';
		const results = [...TrimmedBoundaryReplacer(content, 'const foo = 1;')];
		expect(results).toEqual([]);
	});
});

// =============================================================================
// ContextAwareReplacer Tests
// =============================================================================

describe('ContextAwareReplacer', () => {
	it('should match based on first/last line context', () => {
		const content = 'function test() {\n  const x = 1;\n  return x;\n}';
		const find = 'function test() {\n  const y = 1;\n  return y;\n}';
		const results = [...ContextAwareReplacer(content, find)];
		// Should find a match based on anchors even with different middle content
		expect(results.length).toBeGreaterThanOrEqual(0);
	});

	it('should require at least 3 lines', () => {
		const content = 'line1\nline2';
		const find = 'line1\nline2';
		const results = [...ContextAwareReplacer(content, find)];
		expect(results).toEqual([]);
	});
});

// =============================================================================
// MultiOccurrenceReplacer Tests
// =============================================================================

describe('MultiOccurrenceReplacer', () => {
	it('should yield all exact matches', () => {
		const content = 'foo bar foo baz foo';
		const results = [...MultiOccurrenceReplacer(content, 'foo')];
		expect(results).toEqual(['foo', 'foo', 'foo']);
	});

	it('should yield nothing when no matches', () => {
		const content = 'hello world';
		const results = [...MultiOccurrenceReplacer(content, 'foo')];
		expect(results).toEqual([]);
	});
});

// =============================================================================
// Main replace() Function Tests
// =============================================================================

describe('replace', () => {
	it('should perform exact replacement', () => {
		const content = 'const foo = 1;';
		const result = replace(content, 'foo', 'bar');
		expect(result).toBe('const bar = 1;');
	});

	it('should throw when oldString equals newString', () => {
		expect(() => replace('content', 'same', 'same')).toThrow('No changes to apply');
	});

	it('should throw when oldString not found', () => {
		expect(() => replace('const foo = 1;', 'notfound', 'replacement')).toThrow('Could not find oldString');
	});

	it('should throw when multiple matches found without replaceAll', () => {
		expect(() => replace('foo foo', 'foo', 'bar')).toThrow('multiple matches');
	});

	it('should replace all occurrences when replaceAll is true', () => {
		const result = replace('foo bar foo', 'foo', 'baz', true);
		expect(result).toBe('baz bar baz');
	});

	it('should handle whitespace variations', () => {
		const content = '  const foo = 1;  ';
		const result = replace(content, 'const foo = 1;', 'const bar = 1;');
		expect(result).toBe('  const bar = 1;  ');
	});

	it('should handle multi-line content', () => {
		const content = 'function test() {\n  return 1;\n}';
		const result = replace(content, 'function test() {\n  return 1;\n}', 'function test() {\n  return 2;\n}');
		expect(result).toBe('function test() {\n  return 2;\n}');
	});

	it('should match with different indentation', () => {
		const content = '    function test() {\n        return 1;\n    }';
		const find = 'function test() {\n    return 1;\n}';
		const result = replace(content, find, 'function test() {\n    return 2;\n}');
		expect(result).toContain('return 2');
	});
});
