/**
 * Toast Store Tests
 *
 * Unit tests for the imperative toast notification store.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { getSnapshot, removeToast, subscribe, toast } from './toast-store';

describe('toast store', () => {
	afterEach(() => {
		// Clean up all toasts after each test
		for (const item of getSnapshot()) {
			removeToast(item.id);
		}
	});

	it('starts with an empty list', () => {
		expect(getSnapshot()).toEqual([]);
	});

	it('adds an error toast', () => {
		toast.error('Something went wrong');
		const items = getSnapshot();
		expect(items).toHaveLength(1);
		expect(items[0].message).toBe('Something went wrong');
		expect(items[0].variant).toBe('error');
	});

	it('adds multiple toasts', () => {
		toast.error('Error 1');
		toast.error('Error 2');
		expect(getSnapshot()).toHaveLength(2);
	});

	it('assigns unique ids', () => {
		toast.error('A');
		toast.error('B');
		const items = getSnapshot();
		expect(items[0].id).not.toBe(items[1].id);
	});

	it('removes a toast by id', () => {
		toast.error('To remove');
		const [item] = getSnapshot();
		removeToast(item.id);
		expect(getSnapshot()).toHaveLength(0);
	});

	it('only removes the targeted toast', () => {
		toast.error('Keep');
		toast.error('Remove');
		const items = getSnapshot();
		removeToast(items[1].id);
		const remaining = getSnapshot();
		expect(remaining).toHaveLength(1);
		expect(remaining[0].message).toBe('Keep');
	});

	it('notifies subscribers on add', () => {
		let callCount = 0;
		const unsubscribe = subscribe(() => {
			callCount++;
		});
		toast.error('Test');
		expect(callCount).toBe(1);
		unsubscribe();
	});

	it('notifies subscribers on remove', () => {
		toast.error('Test');
		let callCount = 0;
		const unsubscribe = subscribe(() => {
			callCount++;
		});
		removeToast(getSnapshot()[0].id);
		expect(callCount).toBe(1);
		unsubscribe();
	});

	it('does not notify after unsubscribe', () => {
		let callCount = 0;
		const unsubscribe = subscribe(() => {
			callCount++;
		});
		unsubscribe();
		toast.error('Test');
		expect(callCount).toBe(0);
	});
});
