import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { ProjectFilesystem } from './project-filesystem';

function getFilesystemStub(name: string): DurableObjectStub<ProjectFilesystem> {
	const namespace = env.DurableObjectFilesystem as DurableObjectNamespace<ProjectFilesystem>;
	return namespace.getByName(name);
}

async function readViaMount(stub: DurableObjectStub<ProjectFilesystem>, path: string): Promise<string> {
	const data = await stub.wsReadFile(path);
	return data ?? '';
}

describe('ProjectFilesystem writes', () => {
	it('writeFileContent persists non-empty content and creates parent directories', async () => {
		const stub = getFilesystemStub('test-fs-direct-single');
		const content = 'export const value = 42;\n';

		await stub.writeFileContent('/src/index.ts', content);

		expect(await readViaMount(stub, '/src/index.ts')).toBe(content);
	});

	it('writeFiles seeds a full project in one RPC call with intact content', async () => {
		const stub = getFilesystemStub('test-fs-direct-multi');
		const files = [
			{ path: '/package.json', content: '{\n\t"name": "generated-name"\n}\n' },
			{ path: '/worker/index.ts', content: '// Worker entry point\nexport default { fetch: () => new Response("ok") };\n' },
			{ path: '/src/app.tsx', content: 'export function App() {\n\treturn null;\n}\n' },
			{ path: '/.initialized', content: '1' },
		];

		await stub.writeFiles(files);

		for (const file of files) {
			expect(await readViaMount(stub, file.path), `content of ${file.path}`).toBe(file.content);
		}
		await expect(stub.projectExists()).resolves.toBe(true);
	});

	it('writeFileContent overwrites existing content (truncate semantics)', async () => {
		const stub = getFilesystemStub('test-fs-direct-overwrite');
		await stub.writeFileContent('/notes.txt', 'first version that is long');
		await stub.writeFileContent('/notes.txt', 'second');

		expect(await readViaMount(stub, '/notes.txt')).toBe('second');
	});
});
