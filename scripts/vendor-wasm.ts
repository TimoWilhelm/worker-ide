/**
 * Postinstall script that vendors WASM modules into the `vendor/` directory.
 *
 * 1. Copies `esbuild-wasm/esbuild.wasm` → `vendor/esbuild.wasm`
 * 2. Optimizes `@biomejs/wasm-web/biome_wasm_bg.wasm` with `wasm-opt` and
 *    writes the result to `vendor/biome_wasm_bg.wasm`. If `wasm-opt` is not
 *    installed, falls back to a raw copy with a warning.
 *
 * Run with: `bun scripts/vendor-wasm.ts`
 *
 * The optimized Biome WASM must be under 25 MiB to deploy as a Cloudflare
 * Workers module. The `-Oz --strip-debug --strip-producers` flags typically
 * reduce it from ~28 MiB to ~22 MiB.
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR_DIRECTORY = path.join(ROOT, 'vendor');
const MAX_WASM_SIZE = 25 * 1024 * 1024; // 25 MiB Cloudflare Workers module limit

function ensureVendorDirectory(): void {
	mkdirSync(VENDOR_DIRECTORY, { recursive: true });
}

// ---------------------------------------------------------------------------
// esbuild WASM — simple copy
// ---------------------------------------------------------------------------

function vendorEsbuildWasm(): void {
	const source = path.join(ROOT, 'node_modules/esbuild-wasm/esbuild.wasm');
	const destination = path.join(VENDOR_DIRECTORY, 'esbuild.wasm');

	if (!existsSync(source)) {
		console.warn('[vendor-wasm] esbuild-wasm/esbuild.wasm not found — skipping');
		return;
	}

	copyFileSync(source, destination);
	const size = statSync(destination).size;
	console.log(`[vendor-wasm] esbuild.wasm → vendor/ (${(size / 1024 / 1024).toFixed(1)} MiB)`);
}

// ---------------------------------------------------------------------------
// Biome WASM — optimize with wasm-opt, fall back to raw copy
// ---------------------------------------------------------------------------

function findWasmOpt(): string | undefined {
	try {
		// Check if wasm-opt is on PATH (e.g. installed via brew or apt)
		execFileSync('wasm-opt', ['--version'], { stdio: 'pipe' });
		return 'wasm-opt';
	} catch {
		// Not on PATH
	}
	return undefined;
}

function vendorBiomeWasm(): void {
	const source = path.join(ROOT, 'node_modules/@biomejs/wasm-web/biome_wasm_bg.wasm');
	const destination = path.join(VENDOR_DIRECTORY, 'biome_wasm_bg.wasm');

	if (!existsSync(source)) {
		console.warn('[vendor-wasm] @biomejs/wasm-web/biome_wasm_bg.wasm not found — skipping');
		return;
	}

	const originalSize = statSync(source).size;
	const wasmOpt = findWasmOpt();

	if (wasmOpt) {
		console.log(`[vendor-wasm] Optimizing biome WASM with wasm-opt (${(originalSize / 1024 / 1024).toFixed(1)} MiB)...`);
		try {
			execFileSync(wasmOpt, ['-Oz', '--strip-debug', '--strip-producers', source, '-o', destination], {
				stdio: 'inherit',
				timeout: 10 * 60 * 1000, // 10 minute timeout
			});

			const optimizedSize = statSync(destination).size;
			const reduction = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
			console.log(`[vendor-wasm] biome_wasm_bg.wasm → vendor/ (${(optimizedSize / 1024 / 1024).toFixed(1)} MiB, ${reduction}% reduction)`);

			if (optimizedSize > MAX_WASM_SIZE) {
				throw new Error(
					`[vendor-wasm] Optimized WASM is ${(optimizedSize / 1024 / 1024).toFixed(1)} MiB, ` +
						`exceeds the 25 MiB Cloudflare Workers module limit.`,
				);
			}
			return;
		} catch (error) {
			console.warn(`[vendor-wasm] wasm-opt failed: ${error instanceof Error ? error.message : error}`);
			console.warn('[vendor-wasm] Falling back to raw copy');
		}
	} else {
		console.warn('[vendor-wasm] wasm-opt not found on PATH — copying unoptimized WASM');
		console.warn('[vendor-wasm] Install binaryen for optimized builds: brew install binaryen (macOS) / apt install binaryen (Linux)');
	}

	// Fallback: raw copy
	copyFileSync(source, destination);
	const size = statSync(destination).size;
	console.log(`[vendor-wasm] biome_wasm_bg.wasm → vendor/ (${(size / 1024 / 1024).toFixed(1)} MiB, unoptimized)`);

	if (size > MAX_WASM_SIZE) {
		console.warn(
			`[vendor-wasm] WARNING: Unoptimized WASM is ${(size / 1024 / 1024).toFixed(1)} MiB, ` +
				`exceeds the 25 MiB Cloudflare Workers module limit. Install binaryen to optimize.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Skip in CI — vendored WASM files are committed to git, so CI doesn't need
// to re-vendor (and doesn't have wasm-opt installed).
if (process.env.CI) {
	console.log('[vendor-wasm] CI detected — skipping');
} else {
	ensureVendorDirectory();
	vendorEsbuildWasm();
	vendorBiomeWasm();
}
