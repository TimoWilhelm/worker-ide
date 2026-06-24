import { describe, expect, it } from 'vitest';

import { withLock } from './file-lock';

describe('withLock', () => {
	it('serializes concurrent operations on the same file', async () => {
		const executionOrder: number[] = [];

		const operation1 = withLock('/src/app.ts', async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			executionOrder.push(1);
		});

		const operation2 = withLock('/src/app.ts', async () => {
			executionOrder.push(2);
		});

		await Promise.all([operation1, operation2]);

		// Operation 1 should complete before operation 2 starts.
		expect(executionOrder).toEqual([1, 2]);
	});

	it('allows concurrent operations on different files', async () => {
		const executionOrder: number[] = [];

		const operation1 = withLock('/src/a.ts', async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			executionOrder.push(1);
		});

		const operation2 = withLock('/src/b.ts', async () => {
			executionOrder.push(2);
		});

		await Promise.all([operation1, operation2]);

		// Operation 2 on a different file should not wait for operation 1.
		expect(executionOrder).toEqual([2, 1]);
	});

	it('normalizes paths so locking is consistent with and without a leading slash', async () => {
		const executionOrder: number[] = [];

		const operation1 = withLock('/src/app.ts', async () => {
			await new Promise((resolve) => setTimeout(resolve, 10));
			executionOrder.push(1);
		});

		const operation2 = withLock('src/app.ts', async () => {
			executionOrder.push(2);
		});

		await Promise.all([operation1, operation2]);

		expect(executionOrder).toEqual([1, 2]);
	});

	it('releases the lock even if the function throws', async () => {
		await expect(
			withLock('/src/app.ts', async () => {
				throw new Error('test error');
			}),
		).rejects.toThrow('test error');

		// Subsequent lock acquisition should still work.
		const result = await withLock('/src/app.ts', async () => 'success');
		expect(result).toBe('success');
	});
});
