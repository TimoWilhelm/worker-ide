import { beforeEach, describe, expect, it, vi } from 'vitest';

import { enqueueSave, flushQueuedSaves, listQueuedSaves, removeQueuedSave } from './save-queue';

function installLocalStorage(): void {
	const values = new Map<string, string>();
	vi.stubGlobal('localStorage', {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key: string) => values.get(key),
		key: (index: number) => [...values.keys()][index],
		removeItem: (key: string) => values.delete(key),
		setItem: (key: string, value: string) => values.set(key, value),
	});
}

describe('save queue', () => {
	beforeEach(() => {
		vi.unstubAllGlobals();
		installLocalStorage();
	});

	it('persists queued saves', () => {
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'content', operationId: 'operation-1' });

		expect(listQueuedSaves()).toMatchObject([
			{ projectId: 'project-1', path: '/src/app.ts', content: 'content', operationId: 'operation-1', attemptCount: 0 },
		]);
	});

	it('dedupes saves by project and path', () => {
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'old', operationId: 'operation-1' });
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'new', operationId: 'operation-2' });

		expect(listQueuedSaves()).toMatchObject([
			{ projectId: 'project-1', path: '/src/app.ts', content: 'new', operationId: 'operation-2', attemptCount: 0 },
		]);
	});

	it('removes a queued save only when operation id matches', () => {
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'content', operationId: 'operation-1' });

		removeQueuedSave('project-1', '/src/app.ts', 'operation-2');
		expect(listQueuedSaves()).toHaveLength(1);

		removeQueuedSave('project-1', '/src/app.ts', 'operation-1');
		expect(listQueuedSaves()).toHaveLength(0);
	});

	it('removes entries after a successful flush', async () => {
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'content', operationId: 'operation-1' });
		const save = vi.fn(async () => {});

		await flushQueuedSaves({ projectId: 'project-1', save });

		expect(save).toHaveBeenCalledOnce();
		expect(listQueuedSaves()).toHaveLength(0);
	});

	it('keeps entries and increments attempts after a failed flush', async () => {
		enqueueSave({ projectId: 'project-1', path: '/src/app.ts', content: 'content', operationId: 'operation-1' });
		const save = vi.fn(async () => {
			throw new Error('offline');
		});

		await flushQueuedSaves({ projectId: 'project-1', save });

		expect(listQueuedSaves()).toMatchObject([{ path: '/src/app.ts', attemptCount: 1 }]);
	});

	it('ignores corrupt persisted data', () => {
		localStorage.setItem('worker-ide-save-queue:v1', '{bad json');

		expect(listQueuedSaves()).toEqual([]);
		expect(localStorage.getItem('worker-ide-save-queue:v1')).toBeUndefined();
	});
});
