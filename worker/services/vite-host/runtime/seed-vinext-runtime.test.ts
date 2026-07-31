import { describe, expect, it } from 'vitest';

import { patchVinextRscHmrRecovery } from './seed-vinext-runtime';
import { decompressVendoredFile } from './vendored-decompress';
import vinextRuntimeFiles from '../../../../auxiliary/vite-host/vendor/vinext-runtime.js';

describe('patchVinextRscHmrRecovery', () => {
	it('retries the latest failed RSC update before surfacing an error', () => {
		const source = decompressVendoredFile(vinextRuntimeFiles['server/app-browser-entry.js']);
		const patched = patchVinextRscHmrRecovery(source);

		expect(patched).toContain('if (updateId !== latestRscHmrUpdateId) return;');
		expect(patched).toContain('handleRscUpdate(updateId, attempt + 1)');
		expect(patched).toContain('if (attempt < 2)');
	});

	it('fails loudly when the upstream handler changes', () => {
		expect(() => patchVinextRscHmrRecovery('export {};')).toThrow('handler source changed');
	});
});
