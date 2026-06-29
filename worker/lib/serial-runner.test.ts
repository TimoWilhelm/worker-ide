import { describe, expect, it } from 'vitest';

import { createSerialRunner } from './serial-runner';

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('createSerialRunner', () => {
	it('runs tasks one at a time without overlap, in submission order', async () => {
		const run = createSerialRunner();
		const events: string[] = [];
		let active = 0;

		const task = (name: string, delay: number) =>
			run(async () => {
				active += 1;
				expect(active).toBe(1); // no two tasks run concurrently
				events.push(`start:${name}`);
				await tick(delay);
				events.push(`end:${name}`);
				active -= 1;
				return name;
			});

		// Submit a slow task first, then faster ones; order must be preserved.
		const results = await Promise.all([task('a', 30), task('b', 5), task('c', 1)]);

		expect(results).toEqual(['a', 'b', 'c']);
		expect(events).toEqual(['start:a', 'end:a', 'start:b', 'end:b', 'start:c', 'end:c']);
	});

	it('keeps the queue alive after a task rejects', async () => {
		const run = createSerialRunner();

		await expect(
			run(async () => {
				throw new Error('boom');
			}),
		).rejects.toThrow('boom');
		await expect(run(async () => 'ok')).resolves.toBe('ok');
	});
});
