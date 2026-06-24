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

describe('ProjectFilesystem change drain', () => {
	it('buffers workspace writes and clears them on drain', async () => {
		const stub = getFilesystemStub('test-fs-drain');
		await stub.drainWorkspaceChanges();

		await stub.wsWriteFile('/src/a.ts', 'export const a = 1;\n');
		await stub.wsWriteFile('/src/b.ts', 'export const b = 2;\n');

		const changes = await stub.drainWorkspaceChanges();
		const paths = changes.map((change) => change.path);
		expect(paths).toContain('/src/a.ts');
		expect(paths).toContain('/src/b.ts');

		// Draining a second time returns nothing — the buffer was cleared.
		expect(await stub.drainWorkspaceChanges()).toEqual([]);
	});

	it('excludes .git writes from the change buffer', async () => {
		const stub = getFilesystemStub('test-fs-drain-git');
		await stub.drainWorkspaceChanges();

		await stub.wsWriteFile('/.git/config', '[core]\n');
		await stub.wsWriteFile('/src/c.ts', 'export const c = 3;\n');

		const changes = await stub.drainWorkspaceChanges();
		const paths = changes.map((change) => change.path);
		expect(paths).toContain('/src/c.ts');
		expect(paths.some((path) => path.startsWith('/.git'))).toBe(false);
	});
});
