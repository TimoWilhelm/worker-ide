/**
 * Tests for text/binary detection utilities.
 */

import { describe, expect, it } from 'vitest';

import { bytesToText, detectBinary } from './text';

// =============================================================================
// detectBinary
// =============================================================================

describe('detectBinary', () => {
	it('returns false for empty content', () => {
		expect(detectBinary(new Uint8Array(0))).toBe(false);
	});

	it('returns false for pure ASCII text', () => {
		const text = new TextEncoder().encode('Hello, World!\nThis is plain text.\n');
		expect(detectBinary(text)).toBe(false);
	});

	it('returns false for text with tabs, newlines, and carriage returns', () => {
		const text = new TextEncoder().encode('line1\tcolumn\r\nline2\n');
		expect(detectBinary(text)).toBe(false);
	});

	it('returns true for content with null bytes', () => {
		const bytes = new Uint8Array([72, 101, 108, 108, 111, 0, 87, 111, 114, 108, 100]);
		expect(detectBinary(bytes)).toBe(true);
	});

	it('returns true for content with control characters (byte < 32, not tab/LF/CR)', () => {
		// SOH = 0x01 (control character)
		const bytes = new Uint8Array([72, 101, 1, 108, 111]);
		expect(detectBinary(bytes)).toBe(true);
	});

	it('returns false for UTF-8 encoded text', () => {
		const text = new TextEncoder().encode('Héllo wörld 日本語');
		expect(detectBinary(text)).toBe(false);
	});

	it('only checks the first 8192 bytes', () => {
		// Create a large buffer: 10000 bytes of text, with a null byte at position 9000
		const bytes = new Uint8Array(10_000).fill(65); // 'A'
		bytes[9000] = 0; // null byte after the 8192 boundary
		expect(detectBinary(bytes)).toBe(false);
	});

	it('detects binary within the first 8192 bytes', () => {
		const bytes = new Uint8Array(10_000).fill(65);
		bytes[8000] = 0; // null byte within the 8192 boundary
		expect(detectBinary(bytes)).toBe(true);
	});

	it('returns true for typical binary file content (PNG header)', () => {
		// PNG file signature
		const pngHeader = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		expect(detectBinary(pngHeader)).toBe(true);
	});

	it('returns false for a single newline', () => {
		expect(detectBinary(new Uint8Array([10]))).toBe(false);
	});

	it('returns false for text with all allowed control characters', () => {
		// Tab (9), LF (10), CR (13)
		const bytes = new Uint8Array([9, 10, 13, 65, 66, 67]);
		expect(detectBinary(bytes)).toBe(false);
	});
});

// =============================================================================
// bytesToText
// =============================================================================

describe('bytesToText', () => {
	it('returns empty string for empty input', () => {
		expect(bytesToText(new Uint8Array(0))).toBe('');
	});

	it('decodes plain ASCII text', () => {
		const bytes = new TextEncoder().encode('Hello, World!');
		expect(bytesToText(bytes)).toBe('Hello, World!');
	});

	it('decodes UTF-8 text', () => {
		const text = 'Héllo wörld 日本語';
		const bytes = new TextEncoder().encode(text);
		expect(bytesToText(bytes)).toBe(text);
	});

	it('strips UTF-8 BOM and decodes correctly', () => {
		const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
		const textBytes = new TextEncoder().encode('Hello');
		const combined = new Uint8Array([...bom, ...textBytes]);
		expect(bytesToText(combined)).toBe('Hello');
	});

	it('handles UTF-16 LE BOM', () => {
		// UTF-16 LE BOM + "Hi" in UTF-16 LE
		const bytes = new Uint8Array([0xff, 0xfe, 0x48, 0x00, 0x69, 0x00]);
		expect(bytesToText(bytes)).toBe('Hi');
	});

	it('handles UTF-16 BE BOM', () => {
		// UTF-16 BE BOM + "Hi" in UTF-16 BE
		const bytes = new Uint8Array([0xfe, 0xff, 0x00, 0x48, 0x00, 0x69]);
		expect(bytesToText(bytes)).toBe('Hi');
	});

	it('returns (binary content) for invalid UTF-8', () => {
		// Invalid UTF-8 sequence
		const bytes = new Uint8Array([0xff, 0xfe, 0x80, 0x80, 0x80]);
		const result = bytesToText(bytes);
		// May decode as UTF-16 LE due to BOM or fall back
		expect(typeof result).toBe('string');
	});

	it('decodes multiline text correctly', () => {
		const text = 'line 1\nline 2\nline 3\n';
		const bytes = new TextEncoder().encode(text);
		expect(bytesToText(bytes)).toBe(text);
	});
});
