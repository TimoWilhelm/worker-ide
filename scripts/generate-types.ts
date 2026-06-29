import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

import { parseJsonc } from '../shared/jsonc';

interface AuxiliaryWorkerConfig {
	name: string;
	configPath: string;
	outputPath: string;
	envInterface: string;
}

function getDeclaredStringEnvironmentKeys(configPath: string): Set<string> {
	const rawConfig = readFileSync(configPath, 'utf8');
	const parsedConfig: unknown = parseJsonc(rawConfig);

	if (typeof parsedConfig !== 'object' || parsedConfig === null) {
		return new Set();
	}

	const declaredKeys = new Set<string>();

	if ('vars' in parsedConfig) {
		const { vars } = parsedConfig;
		if (typeof vars === 'object' && vars !== null) {
			for (const key of Object.keys(vars)) {
				declaredKeys.add(key);
			}
		}
	}

	if ('secrets' in parsedConfig) {
		const { secrets } = parsedConfig;
		if (typeof secrets === 'object' && secrets !== null && 'required' in secrets) {
			const { required } = secrets;
			if (Array.isArray(required)) {
				for (const key of required) {
					if (typeof key === 'string') {
						declaredKeys.add(key);
					}
				}
			}
		}
	}

	return declaredKeys;
}

function filterGeneratedStringEnvironment(content: string, declaredKeys: Set<string>): string {
	const filteredLines = content
		.split('\n')
		.filter((line) => {
			const match = line.match(/^\s+([A-Z0-9_]+): (string|".*");$/);
			if (!match) {
				return true;
			}

			const [, key] = match;
			return declaredKeys.has(key);
		})
		.join('\n');

	const processEnvironmentKeys = [...declaredKeys].map((key) => `"${key}"`).join(' | ') || 'never';

	return filteredLines.replace(
		/interface ProcessEnv extends StringifyValues<Pick<([^,>]+), [^>]+>> \{\}/,
		`interface ProcessEnv extends StringifyValues<Pick<$1, ${processEnvironmentKeys}>> {}`,
	);
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
		name: 'viteHost',
		configPath: 'auxiliary/vite-host/wrangler.jsonc',
		outputPath: 'auxiliary/vite-host/worker-configuration.d.ts',
		envInterface: 'ViteHostWorkerEnvironment',
	},
	{
		name: 'push',
		configPath: 'auxiliary/push/wrangler.jsonc',
		outputPath: 'auxiliary/push/worker-configuration.d.ts',
		envInterface: 'PushWorkerEnvironment',
	},
	{
		name: 'email',
		configPath: 'auxiliary/email/wrangler.jsonc',
		outputPath: 'auxiliary/email/worker-configuration.d.ts',
		envInterface: 'EmailWorkerEnvironment',
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
	const declaredKeys = getDeclaredStringEnvironmentKeys(worker.configPath);
	let content = readFileSync(worker.outputPath, 'utf8');
	content = content
		.replaceAll('declare namespace Cloudflare {', `declare namespace ${namespaceName} {`)
		.replaceAll('Cloudflare.Env', `${namespaceName}.Env`)
		.replaceAll('Cloudflare.GlobalProps', `${namespaceName}.GlobalProps`);
	content = filterGeneratedStringEnvironment(content, declaredKeys);
	writeFileSync(worker.outputPath, content);
	console.log(`[${worker.name}] Post-processed namespace -> ${namespaceName}`);
}

console.log('\nAll worker types generated successfully.');
