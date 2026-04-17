import { WorkerEntrypoint } from 'cloudflare:workers';

import { bundleWithCdn, transformCode } from './esbuild-core';

import type { BundleResult, BundleWithCdnOptions, TransformOptions, TransformResult } from '@shared/bundler-types';

// Re-export standalone functions for direct use in tests
export { bundleWithCdn, transformCode } from './esbuild-core';

export default class EsbuildWorker extends WorkerEntrypoint {
	async transformCode(code: string, filename: string, options?: TransformOptions): Promise<TransformResult> {
		return transformCode(code, filename, options);
	}

	async bundleWithCdn(options: BundleWithCdnOptions): Promise<BundleResult> {
		return bundleWithCdn(options);
	}
}
