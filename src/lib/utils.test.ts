/* eslint-disable unicorn/prevent-abbreviations -- test file for utils.ts which follows shadcn/ui convention */
/**
 * Unit tests for utility functions.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

import {
	cn,
	formatFileSize,
	formatRelativeTime,
	debounce,
	throttle,
	getFileExtension,
	getFilename,
	getDirectory,
	isDirectory,
	normalizePath,
	generateId,
} from './utils';

// =============================================================================
// cn (class merging)
// =============================================================================

describe('cn', () => {
	it('merges class names', () => {
		// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class names
		expect(cn('foo', 'bar')).toBe('foo bar');
	});

	it('handles undefined and null', () => {
		// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class names
		expect(cn('foo', undefined, 'bar')).toBe('foo bar');
	});

	it('merges conflicting tailwind classes', () => {
		expect(cn('px-4', 'px-2')).toBe('px-2');
	});

	it('handles conditional classes', () => {
		const isFalse = false;
		const isTrue = true;
		// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class names
		expect(cn('base', isFalse && 'hidden', isTrue && 'visible')).toBe('base visible');
	});
});

// =============================================================================
// formatFileSize
// =============================================================================

describe('formatFileSize', () => {
	it('formats 0 bytes', () => {
		expect(formatFileSize(0)).toBe('0 B');
	});

	it('formats bytes', () => {
		expect(formatFileSize(500)).toBe('500 B');
	});

	it('formats kilobytes', () => {
		expect(formatFileSize(1024)).toBe('1 KB');
		expect(formatFileSize(1536)).toBe('1.5 KB');
	});

	it('formats megabytes', () => {
		expect(formatFileSize(1_048_576)).toBe('1 MB');
	});

	it('formats gigabytes', () => {
		expect(formatFileSize(1_073_741_824)).toBe('1 GB');
	});
});

// =============================================================================
// formatRelativeTime
// =============================================================================

describe('formatRelativeTime', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-15T12:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns "just now" for recent timestamps', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 5000)).toBe('just now');
	});

	it('returns minutes ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 120_000)).toBe('2m ago');
	});

	it('returns hours ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 7_200_000)).toBe('2h ago');
	});

	it('returns days ago', () => {
		const now = Date.now();
		expect(formatRelativeTime(now - 172_800_000)).toBe('2d ago');
	});
});

// =============================================================================
// debounce
// =============================================================================

describe('debounce', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('delays function execution', () => {
		const function_ = vi.fn();
		const debounced = debounce(function_, 100);

		debounced();
		expect(function_).not.toHaveBeenCalled();

		vi.advanceTimersByTime(100);
		expect(function_).toHaveBeenCalledOnce();
	});

	it('resets delay on subsequent calls', () => {
		const function_ = vi.fn();
		const debounced = debounce(function_, 100);

		debounced();
		vi.advanceTimersByTime(50);
		debounced();
		vi.advanceTimersByTime(50);
		expect(function_).not.toHaveBeenCalled();

		vi.advanceTimersByTime(50);
		expect(function_).toHaveBeenCalledOnce();
	});
});

// =============================================================================
// throttle
// =============================================================================

describe('throttle', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls function immediately on first call', () => {
		const function_ = vi.fn();
		const throttled = throttle(function_, 100);

		throttled();
		expect(function_).toHaveBeenCalledOnce();
	});

	it('throttles subsequent calls', () => {
		const function_ = vi.fn();
		const throttled = throttle(function_, 100);

		throttled();
		throttled();
		throttled();
		expect(function_).toHaveBeenCalledOnce();
	});

	it('allows calls after delay', () => {
		const function_ = vi.fn();
		const throttled = throttle(function_, 100);

		throttled();
		vi.advanceTimersByTime(100);
		throttled();
		expect(function_).toHaveBeenCalledTimes(2);
	});
});

// =============================================================================
// Path utilities
// =============================================================================

describe('getFileExtension', () => {
	it('returns extension for simple files', () => {
		expect(getFileExtension('file.ts')).toBe('ts');
	});

	it('returns extension for files with path', () => {
		expect(getFileExtension('/src/main.tsx')).toBe('tsx');
	});

	it('returns empty string for no extension', () => {
		expect(getFileExtension('Makefile')).toBe('');
	});

	it('returns last extension for multiple dots', () => {
		expect(getFileExtension('file.test.ts')).toBe('ts');
	});

	it('returns lowercase extension', () => {
		expect(getFileExtension('file.TSX')).toBe('tsx');
	});
});

describe('getFilename', () => {
	it('returns filename from path', () => {
		expect(getFilename('/src/main.ts')).toBe('main.ts');
	});

	it('returns filename for root file', () => {
		expect(getFilename('/file.ts')).toBe('file.ts');
	});

	it('returns the input if no slash', () => {
		expect(getFilename('file.ts')).toBe('file.ts');
	});
});

describe('getDirectory', () => {
	it('returns directory from path', () => {
		expect(getDirectory('/src/main.ts')).toBe('/src');
	});

	it('returns root for root file', () => {
		expect(getDirectory('/file.ts')).toBe('/');
	});

	it('handles nested paths', () => {
		expect(getDirectory('/src/features/editor/code.tsx')).toBe('/src/features/editor');
	});
});

describe('isDirectory', () => {
	it('returns true for directories', () => {
		expect(isDirectory('/src/')).toBe(true);
	});

	it('returns false for files', () => {
		expect(isDirectory('/src/main.ts')).toBe(false);
	});
});

describe('normalizePath', () => {
	it('adds leading slash', () => {
		expect(normalizePath('src/main.ts')).toBe('/src/main.ts');
	});

	it('removes duplicate leading slashes', () => {
		expect(normalizePath('///src/main.ts')).toBe('/src/main.ts');
	});

	it('removes consecutive slashes', () => {
		expect(normalizePath('/src//main.ts')).toBe('/src/main.ts');
	});
});

describe('generateId', () => {
	it('generates an ID of default length', () => {
		const id = generateId();
		expect(id).toHaveLength(8);
	});

	it('generates an ID of specified length', () => {
		const id = generateId(16);
		expect(id).toHaveLength(16);
	});

	it('generates alphanumeric characters only', () => {
		const id = generateId(100);
		expect(id).toMatch(/^[a-z0-9]+$/);
	});

	it('generates unique IDs', () => {
		const ids = new Set(Array.from({ length: 100 }, () => generateId()));
		expect(ids.size).toBe(100);
	});
});
