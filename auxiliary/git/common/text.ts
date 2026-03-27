/**
 * Text/binary detection utilities.
 * Extracted from git-on-cloudflare's web/format.ts.
 */

/**
 * Detects if content is binary by checking for non-text bytes.
 * Checks first 8 KB for null bytes or control characters.
 */
export function detectBinary(bytes: Uint8Array): boolean {
	const checkLength = Math.min(8192, bytes.length);
	for (let index = 0; index < checkLength; index++) {
		const byte = bytes[index];
		if (byte === 0 || (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13)) {
			return true;
		}
	}
	return false;
}

/**
 * Converts byte array to text, handling UTF-8/UTF-16 BOM detection.
 */
export function bytesToText(bytes: Uint8Array): string {
	if (!bytes || bytes.byteLength === 0) return '';
	// UTF-8 BOM
	if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
		return new TextDecoder('utf-8').decode(bytes.subarray(3));
	}
	// UTF-16 LE BOM
	if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
		try {
			return new TextDecoder('utf-16le').decode(bytes.subarray(2));
		} catch {
			// fall through
		}
	}
	// UTF-16 BE BOM
	if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
		try {
			return new TextDecoder('utf-16be').decode(bytes.subarray(2));
		} catch {
			// fall through
		}
	}
	// Default to UTF-8
	try {
		return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
	} catch {
		return '(binary content)';
	}
}
