import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { mount, withMounts } from 'worker-fs-mount';
import { mkdir, readFile, writeFile } from 'worker-fs-mount/fs';

import type { ProjectFilesystem } from './project-filesystem';

/**
 * Regression test for empty project files.
 *
 * Writes to the ProjectFilesystem Durable Object go through worker-fs-mount's
 * async `writeFile`, which returns a `WritableStream` over Durable Object RPC
 * and resolves its `close()` via a cross-request promise continuation.
 *
 * The `no_handle_cross_request_promise_resolution` compatibility flag (removed
 * from wrangler.jsonc) reverted workerd to legacy behavior that dropped those
 * continuations, causing every written file to persist empty while reads still
 * worked. This test asserts a write -> read round-trip preserves content, so it
 * fails if that flag (or equivalent behavior) is reintroduced.
 */
function getFilesystemStub(name: string): DurableObjectStub<ProjectFilesystem> {
	const namespace = env.DurableObjectFilesystem as DurableObjectNamespace<ProjectFilesystem>;
	return namespace.getByName(name);
}

describe('ProjectFilesystem streaming write round-trip', () => {
	it('persists written file content (not empty) across a mount write/read', async () => {
		const stub = getFilesystemStub('test-fs-roundtrip');
		const content = 'export const value = 42;\n';

		const readBack = await withMounts(async () => {
			mount('/project', stub);
			await mkdir('/project/src', { recursive: true });
			await writeFile('/project/src/index.ts', content);
			return readFile('/project/src/index.ts', 'utf8');
		});

		expect(readBack).toBe(content);
	});

	it('persists multiple files written sequentially in a single mount context', async () => {
		const stub = getFilesystemStub('test-fs-roundtrip-multi');
		const files: Record<string, string> = {
			'/project/package.json': '{\n\t"name": "generated-name"\n}\n',
			'/project/worker/index.ts': '// Worker entry point\nexport default { fetch: () => new Response("ok") };\n',
			'/project/src/app.tsx': 'export function App() {\n\treturn null;\n}\n',
		};

		const readBack = await withMounts(async () => {
			mount('/project', stub);
			for (const [path, body] of Object.entries(files)) {
				const directory = path.slice(0, path.lastIndexOf('/'));
				await mkdir(directory, { recursive: true });
				await writeFile(path, body);
			}

			const result: Record<string, string> = {};
			for (const path of Object.keys(files)) {
				const data = await readFile(path, 'utf8');
				result[path] = typeof data === 'string' ? data : data.toString('utf8');
			}
			return result;
		});

		expect(readBack).toEqual(files);
	});
});
