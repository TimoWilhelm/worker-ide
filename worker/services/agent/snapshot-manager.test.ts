import { beforeEach, describe, expect, it, vi } from 'vitest';

const files = new Map<string, string>();
const directories = new Set<string>();

vi.mock('@worker/lib/project-fs', () => ({
	fs: {
		mkdir: vi.fn(async (path: string) => {
			directories.add(path);
		}),
		writeFile: vi.fn(async (path: string, content: string) => {
			files.set(path, content);
		}),
		readFile: vi.fn(async (path: string) => {
			const content = files.get(path);
			if (content === undefined) throw new Error('ENOENT');
			return content;
		}),
		readdir: vi.fn(async () => []),
		unlink: vi.fn(async (path: string) => {
			files.delete(path);
		}),
		rmdir: vi.fn(async (path: string) => {
			directories.delete(path);
		}),
	},
}));

import { addFileToSnapshot, initSnapshot } from './snapshot-manager';

import type { ModelMessage } from 'ai';

describe('agent turn snapshots', () => {
	beforeEach(() => {
		files.clear();
		directories.clear();
	});

	it('creates labeled metadata and emits the snapshot event', async () => {
		const events: Array<[string, Record<string, unknown>]> = [];
		const messages: ModelMessage[] = [{ role: 'user', content: 'Update the project styles' }];

		const snapshot = await initSnapshot('/project', 'session-1', messages, (type, data) => events.push([type, data]));

		expect(snapshot.directory).toBe(`/project/.agent/snapshots/${snapshot.id}`);
		expect(events).toEqual([
			['snapshot_created', expect.objectContaining({ id: snapshot.id, label: 'Update the project styles', changes: [] })],
		]);
		const metadata = JSON.parse(files.get(`${snapshot.directory}/metadata.json`) ?? '');
		expect(metadata).toMatchObject({ id: snapshot.id, sessionId: 'session-1', changes: [] });
	});

	it('stores each changed path original content once', async () => {
		const messages: ModelMessage[] = [{ role: 'user', content: 'Edit files' }];
		const snapshot = await initSnapshot('/project', 'session-1', messages, () => {});

		await addFileToSnapshot(snapshot, {
			path: '/src/app.ts',
			action: 'edit',
			beforeContent: 'before',
			afterContent: 'after',
			isBinary: false,
		});
		await addFileToSnapshot(snapshot, {
			path: '/src/app.ts',
			action: 'edit',
			beforeContent: 'later-before',
			afterContent: 'later-after',
			isBinary: false,
		});

		expect(files.get(`${snapshot.directory}/src/app.ts`)).toBe('before');
		const metadata = JSON.parse(files.get(`${snapshot.directory}/metadata.json`) ?? '');
		expect(metadata.changes).toEqual([{ path: '/src/app.ts', action: 'edit' }]);
	});
});
