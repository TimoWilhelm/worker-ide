/**
 * Generate TypeScript types for all workers.
 *
 * Runs `wrangler types` for:
 * 1. The main worker (includes cross-worker bindings for all auxiliary workers)
 * 2. Each auxiliary worker with its own env interface name
 *
 * Auxiliary workers get a scoped namespace (e.g. CloudflareGitWorker instead of
 * Cloudflare) to prevent merging with the main worker's global Env declaration.
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

interface AuxiliaryWorkerConfig {
	name: string;
	configPath: string;
	outputPath: string;
	envInterface: string;
}

const auxiliaryWorkers: AuxiliaryWorkerConfig[] = [
	{
		name: 'biome',
		configPath: 'auxiliary/biome/wrangler.jsonc',
		outputPath: 'auxiliary/biome/worker-configuration.d.ts',
		envInterface: 'BiomeWorkerEnvironment',
	},
	{
		name: 'esbuild',
		configPath: 'auxiliary/esbuild/wrangler.jsonc',
		outputPath: 'auxiliary/esbuild/worker-configuration.d.ts',
		envInterface: 'EsbuildWorkerEnvironment',
	},
	{
		name: 'git',
		configPath: 'auxiliary/git/wrangler.jsonc',
		outputPath: 'auxiliary/git/worker-configuration.d.ts',
		envInterface: 'GitWorkerEnvironment',
	},
];

// Step 1: Generate types for the main worker (includes all auxiliary worker bindings)
const mainConfigPaths = ['wrangler.jsonc', ...auxiliaryWorkers.map((w) => w.configPath)];
const mainCommand = `wrangler types ${mainConfigPaths.map((c) => `-c ${c}`).join(' ')}`;
console.log(`[main] ${mainCommand}`);
execSync(mainCommand, { stdio: 'inherit' });

// Step 2: Generate types for each auxiliary worker
for (const worker of auxiliaryWorkers) {
	const command = `wrangler types -c ${worker.configPath} ${worker.outputPath} --no-include-runtime --env-interface ${worker.envInterface}`;
	console.log(`[${worker.name}] ${command}`);
	execSync(command, { stdio: 'inherit' });

	// Post-process: rename the Cloudflare namespace to avoid merging with the
	// main worker's global Cloudflare.Env declaration.
	const namespaceName = `Cloudflare${worker.name.charAt(0).toUpperCase()}${worker.name.slice(1)}Worker`;
	let content = readFileSync(worker.outputPath, 'utf8');
	content = content
		.replaceAll('declare namespace Cloudflare {', `declare namespace ${namespaceName} {`)
		.replaceAll('Cloudflare.Env', `${namespaceName}.Env`)
		.replaceAll('Cloudflare.GlobalProps', `${namespaceName}.GlobalProps`);
	writeFileSync(worker.outputPath, content);
	console.log(`[${worker.name}] Post-processed namespace -> ${namespaceName}`);
}

console.log('\nAll worker types generated successfully.');
