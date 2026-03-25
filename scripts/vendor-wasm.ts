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
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const VENDOR_DIRECTORY = path.join(ROOT, 'vendor');

/** WASM modules to vendor. Source paths are relative to `node_modules/`. */
const WASM_MODULES = [
	{ package: 'esbuild-wasm', source: 'esbuild-wasm/esbuild.wasm', output: 'esbuild.wasm' },
	{ package: '@biomejs/wasm-web', source: '@biomejs/wasm-web/biome_wasm_bg.wasm', output: 'biome_wasm_bg.wasm' },
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

function getInstalledVersion(packageName: string): string {
	const packageJsonPath = path.join(ROOT, 'node_modules', packageName, 'package.json');
	const { version } = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
	return version;
}

function vendorModule(wasmOpt: string, { package: packageName, source, output }: (typeof WASM_MODULES)[number]): void {
	const sourcePath = path.join(ROOT, 'node_modules', source);
	const destinationPath = path.join(VENDOR_DIRECTORY, output);
	const versionPath = path.join(VENDOR_DIRECTORY, `${output}.version`);

	if (!existsSync(sourcePath)) {
		throw new Error(`[vendor-wasm] ${source} not found`);
	}

	const installedVersion = getInstalledVersion(packageName);

	if (existsSync(destinationPath) && existsSync(versionPath)) {
		const vendoredVersion = readFileSync(versionPath, 'utf8').trim();
		if (vendoredVersion === installedVersion) {
			console.log(`[vendor-wasm] ${output} is up to date (${installedVersion}) — skipping`);
			return;
		}
	}

	const originalSize = statSync(sourcePath).size;
	console.log(`[vendor-wasm] Optimizing ${output} v${installedVersion} with wasm-opt (${(originalSize / 1024 / 1024).toFixed(1)} MiB)...`);

	execFileSync(wasmOpt, ['-Oz', '--strip-debug', '--strip-producers', '--enable-bulk-memory-opt', sourcePath, '-o', destinationPath], {
		stdio: 'inherit',
		timeout: 10 * 60 * 1000, // 10 minute timeout
	});

	const optimizedSize = statSync(destinationPath).size;
	const reduction = ((1 - optimizedSize / originalSize) * 100).toFixed(1);
	console.log(`[vendor-wasm] ${output} → vendor/ (${(optimizedSize / 1024 / 1024).toFixed(1)} MiB, ${reduction}% reduction)`);

	writeFileSync(versionPath, installedVersion);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (process.env.CI) {
	console.log('[vendor-wasm] CI detected — skipping');
} else {
	mkdirSync(VENDOR_DIRECTORY, { recursive: true });
	const wasmOpt = requireWasmOpt();
	for (const module of WASM_MODULES) {
		vendorModule(wasmOpt, module);
	}
}
