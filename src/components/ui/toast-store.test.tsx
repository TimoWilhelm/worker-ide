import { describe, expect, it } from 'vitest';

import { toast, toastManager } from './toast-store';

import type { ToastData } from './toast-store';

describe('toast store', () => {
	it('adds an error toast via the imperative API', () => {
		let lastAction: string | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			lastAction = event.action;
		});
		toast.error('Something went wrong');
		expect(lastAction).toBe('add');
		unsubscribe();
	});

	it('passes variant through data', () => {
		let addedData: ToastData | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedData = event.options.data;
			}
		});
		toast.error('Oops');
		expect(addedData?.variant).toBe('error');
		unsubscribe();
	});

	it('passes title and description', () => {
		let addedOptions: Record<string, unknown> | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedOptions = event.options;
			}
		});
		toast.error('Detail message', { title: 'Error Title' });
		expect(addedOptions?.title).toBe('Error Title');
		expect(addedOptions?.description).toBe('Detail message');
		unsubscribe();
	});

	it('sets extended timeout for toasts with a title', () => {
		let addedOptions: Record<string, unknown> | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedOptions = event.options;
			}
		});
		toast.error('Detail message', { title: 'Error Title' });
		expect(addedOptions?.timeout).toBe(8000);
		unsubscribe();
	});

	it('omits timeout when no title is provided', () => {
		let addedOptions: Record<string, unknown> | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedOptions = event.options;
			}
		});
		toast.error('Simple message');
		expect(Object.prototype.hasOwnProperty.call(addedOptions ?? {}, 'timeout')).toBe(false);
		unsubscribe();
	});

	it('allows custom duration override', () => {
		let addedOptions: Record<string, unknown> | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedOptions = event.options;
			}
		});
		toast.error('Custom timing', { duration: 15_000 });
		expect(addedOptions?.timeout).toBe(15_000);
		unsubscribe();
	});

	it('uses timeout 0 for persistent toasts', () => {
		let addedOptions: Record<string, unknown> | undefined;
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				addedOptions = event.options;
			}
		});
		toast.info('Persistent toast', { persist: true });
		expect(addedOptions?.timeout).toBe(0);
		unsubscribe();
	});

	it('supports info and success variants', () => {
		const variants: string[] = [];
		const unsubscribe = toastManager[' subscribe']((event) => {
			if (event.action === 'add') {
				variants.push(event.options.data?.variant);
			}
		});
		toast.info('Info');
		toast.success('Success');
		expect(variants).toEqual(['info', 'success']);
		unsubscribe();
	});

	it('notifies subscribers on add', () => {
		let callCount = 0;
		const unsubscribe = toastManager[' subscribe'](() => {
			callCount++;
		});
		toast.error('Test');
		expect(callCount).toBe(1);
		unsubscribe();
	});

	it('does not notify after unsubscribe', () => {
		let callCount = 0;
		const unsubscribe = toastManager[' subscribe'](() => {
			callCount++;
		});
		unsubscribe();
		toast.error('Test');
		expect(callCount).toBe(0);
	});
});
