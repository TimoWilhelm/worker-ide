import { WorkerEntrypoint } from 'cloudflare:workers';

import { fixFile, lintFile } from './biome-core';

import type { FixFileFailure, ServerLintDiagnostic, ServerLintFixResult } from '@shared/biome-types';

// Re-export standalone functions for direct use in tests
export { fixFile, lintFile } from './biome-core';

export default class BiomeWorker extends WorkerEntrypoint {
	async lintFile(filePath: string, content: string): Promise<ServerLintDiagnostic[]> {
		return lintFile(filePath, content);
	}

	async fixFile(filePath: string, content: string): Promise<ServerLintFixResult | FixFileFailure> {
		return fixFile(filePath, content);
	}
}
