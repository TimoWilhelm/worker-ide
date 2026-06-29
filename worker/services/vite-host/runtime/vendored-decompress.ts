/**
 * Decode a vendored file value produced by `scripts/vendor-vite-host.ts`.
 *
 * The vendored React/RSC + vinext runtime maps store each file as
 * `base64(gzip(utf8 source))`. Seeded as a {@link VendoredLayer}, each entry is
 * decompressed lazily on first read, so the build isolate holds the source
 * compressed (~4–5× smaller) and only materialises the handful of files a given
 * build actually touches. `node:zlib`'s synchronous `gunzipSync` is required
 * because the native plugins read these files through a synchronous
 * `readFileSync` facade.
 */
import { gunzipSync, gzipSync } from 'node:zlib';

export function decompressVendoredFile(stored: string): string {
	return gunzipSync(Buffer.from(stored, 'base64')).toString('utf8');
}

/**
 * Encode a raw source string into the vendored `base64(gzip(utf8))` form, for
 * synthetic files the host injects alongside the vendored maps (so the whole
 * layer can share one compressed representation).
 */
export function compressVendoredFile(source: string): string {
	return gzipSync(Buffer.from(source, 'utf8')).toString('base64');
}
