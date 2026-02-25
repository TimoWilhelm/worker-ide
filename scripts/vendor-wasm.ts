/**
 * Postinstall script that optimizes WASM modules with `wasm-opt`
 * and writes the result to the `vendor/` directory.
 *
 * Run with: `bun scripts/vendor-wasm.ts`
 *
 * Requires `wasm-opt` (from Binaryen) to be installed:
 *   brew install binaryen (macOS) / apt install binaryen (Linux)
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR_DIRECTORY = path.join(ROOT, 'vendor');

/** WASM modules to vendor. Source paths are relative to `node_modules/`. */
const WASM_MODULES = [
	{ source: 'esbuild-wasm/esbuild.wasm', output: 'esbuild.wasm' },
	{ source: '@biomejs/wasm-web/biome_wasm_bg.wasm', output: 'biome_wasm_bg.wasm' },
];

function requireWasmOpt(): string {
	try {
		execFileSync('wasm-opt', ['--version'], { stdio: 'pipe' });
		return 'wasm-opt';
	} catch {
		throw new Error(
			'[vendor-wasm] wasm-opt is required but was not found on PATH.\n' +
				'Install binaryen: brew install binaryen (macOS) / apt install binaryen (Linux)',
		);
	}
}

function vendorModule(wasmOpt: string, { source, output }: (typeof WASM_MODULES)[number]): void {
	const sourcePath = path.join(ROOT, 'node_modules', source);
	const destinationPath = path.join(VENDOR_DIRECTORY, output);

	if (!existsSync(sourcePath)) {
		throw new Error(`[vendor-wasm] ${source} not found`);
	}

	const originalSize = statSync(sourcePath).size;
	console.log(`[vendor-wasm] Optimizing ${output} with wasm-opt (${(originalSize / 1024 / 1024).toFixed(1)} MiB)...`);

	execFileSync(wasmOpt, ['-Oz', '--strip-debug', '--strip-producers', '--enable-bulk-memory-opt', sourcePath, '-o', destinationPath], {
		stdio: 'inherit',
		timeout: 10 * 60 * 1000, // 10 minute timeout
	});

	const optimizedSize = statSync(destinationPath).size;
	const reduction = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
	console.log(`[vendor-wasm] ${output} → vendor/ (${(optimizedSize / 1024 / 1024).toFixed(1)} MiB, ${reduction}% reduction)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

// Skip in CI — vendored WASM files are committed to git, so CI doesn't need
// to re-vendor (and doesn't have wasm-opt installed).
if (process.env.CI) {
	console.log('[vendor-wasm] CI detected — skipping');
} else {
	mkdirSync(VENDOR_DIRECTORY, { recursive: true });
	const wasmOpt = requireWasmOpt();
	for (const module of WASM_MODULES) {
		vendorModule(wasmOpt, module);
	}
}
