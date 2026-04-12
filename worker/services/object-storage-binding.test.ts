/**
 * Tests for the ObjectStorageBinding worker entrypoint.
 */

import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { ObjectStorageBinding } from './object-storage-binding';

function createBinding(projectId: string, quotaBytes = 10_000_000) {
	const context = {
		waitUntil() {},
		passThroughOnException() {},
		exports: {},
		props: { projectId, quotaBytes },
	};

	return Reflect.construct(ObjectStorageBinding, [context, env]);
}

function createProjectId(suffix: string): string {
	return `storage-binding-${suffix}-${crypto.randomUUID()}`;
}

describe('ObjectStorageBinding', () => {
	it('returns null from put() when R2 preconditions fail', async () => {
		const binding = createBinding(createProjectId('put-precondition'));

		const initial = await binding.put('note.txt', 'initial value');
		expect(initial).not.toBeNull();

		const result = await binding.put('note.txt', 'updated value', {
			onlyIf: { etagMatches: 'does-not-match' },
		});

		expect(result).toBeNull();

		const stored = await binding.get('note.txt');
		expect(stored).not.toBeNull();
		expect(stored && 'body' in stored).toBe(true);
		if (stored && 'body' in stored) {
			expect(await stored.text()).toBe('initial value');
		}
	});

	it('returns metadata without a body from get() when preconditions fail', async () => {
		const binding = createBinding(createProjectId('get-precondition'));

		const stored = await binding.put('document.txt', 'hello world');
		if (!stored) {
			throw new Error('Expected initial put to succeed');
		}

		const conditionalResult = await binding.get('document.txt', {
			onlyIf: { etagMatches: 'does-not-match' },
		});

		expect(conditionalResult).not.toBeNull();
		expect(conditionalResult?.key).toBe('document.txt');
		expect(conditionalResult && 'body' in conditionalResult).toBe(false);
	});

	it('returns unscoped delimitedPrefixes from list()', async () => {
		const binding = createBinding(createProjectId('list-prefixes'));

		await binding.put('folder/first.txt', 'a');
		await binding.put('folder/second.txt', 'b');
		await binding.put('top-level.txt', 'c');

		const result = await binding.list({ delimiter: '/' });

		expect(result.delimitedPrefixes).toContain('folder/');
		for (const prefix of result.delimitedPrefixes) {
			expect(prefix.startsWith('projects/')).toBe(false);
		}
	});
});
