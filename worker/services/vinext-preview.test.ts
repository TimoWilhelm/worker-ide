import { describe, expect, it } from 'vitest';

import { runWithProjectFs } from '@worker/lib/project-fs';
import { createInMemoryProjectFs } from '@worker/lib/test-workspace';

import { VinextPreviewService } from './vinext-preview';

const vinextManifest = JSON.stringify({ name: 'demo', dependencies: { vinext: '^0.1.0' } });

async function detect(files: Record<string, string>): Promise<boolean> {
	const { workspace, adapter } = createInMemoryProjectFs();
	for (const [path, contents] of Object.entries(files)) {
		await workspace.writeFile(path, contents);
	}
	return runWithProjectFs(adapter, () => new VinextPreviewService('/project', 'project-1').isVinext());
}

describe('VinextPreviewService.isVinext', () => {
	it('detects an App Router vinext project from the bound filesystem', async () => {
		const result = await detect({
			'/project/package.json': vinextManifest,
			'/project/app/page.tsx': 'export default function Page() { return null; }',
		});
		expect(result).toBe(true);
	});

	it('detects a Pages Router vinext project', async () => {
		const result = await detect({
			'/project/package.json': vinextManifest,
			'/project/pages/index.tsx': 'export default function Home() { return null; }',
		});
		expect(result).toBe(true);
	});

	it('returns false when vinext is not a dependency', async () => {
		const result = await detect({
			'/project/package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }),
			'/project/app/page.tsx': 'export default () => null;',
		});
		expect(result).toBe(false);
	});

	it('returns false when there is no router directory', async () => {
		const result = await detect({ '/project/package.json': vinextManifest });
		expect(result).toBe(false);
	});

	it('returns false when there is no package.json', async () => {
		const result = await detect({ '/project/app/page.tsx': 'export default () => null;' });
		expect(result).toBe(false);
	});
});
