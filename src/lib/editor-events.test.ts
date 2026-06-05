import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

import { emitEditorEvent, onEditorEvent } from './editor-events';

import type { ServerError } from '@shared/types';

const originalAddEventListener = Reflect.get(globalThis, 'addEventListener');
const originalRemoveEventListener = Reflect.get(globalThis, 'removeEventListener');
const originalDispatchEvent = Reflect.get(globalThis, 'dispatchEvent');

function installEventTargetPolyfill() {
	const eventTarget = new EventTarget();
	Reflect.set(globalThis, 'addEventListener', eventTarget.addEventListener.bind(eventTarget));
	Reflect.set(globalThis, 'removeEventListener', eventTarget.removeEventListener.bind(eventTarget));
	Reflect.set(globalThis, 'dispatchEvent', eventTarget.dispatchEvent.bind(eventTarget));
}

function restoreEventTargetPolyfill() {
	if (originalAddEventListener === undefined) {
		Reflect.deleteProperty(globalThis, 'addEventListener');
	} else {
		Reflect.set(globalThis, 'addEventListener', originalAddEventListener);
	}

	if (originalRemoveEventListener === undefined) {
		Reflect.deleteProperty(globalThis, 'removeEventListener');
	} else {
		Reflect.set(globalThis, 'removeEventListener', originalRemoveEventListener);
	}

	if (originalDispatchEvent === undefined) {
		Reflect.deleteProperty(globalThis, 'dispatchEvent');
	} else {
		Reflect.set(globalThis, 'dispatchEvent', originalDispatchEvent);
	}
}

describe('editor-events', () => {
	installEventTargetPolyfill();

	afterEach(() => {
		vi.restoreAllMocks();
	});

	afterAll(() => {
		restoreEventTargetPolyfill();
	});

	it('delivers a typed detail payload to listeners', () => {
		const handler = vi.fn();
		const unsubscribe = onEditorEvent('server-error', handler);

		const error: ServerError = { id: 'e1', timestamp: 123, type: 'bundle', message: 'boom' };
		emitEditorEvent('server-error', error);

		expect(handler).toHaveBeenCalledTimes(1);
		expect(handler).toHaveBeenCalledWith(error);
		unsubscribe();
	});

	it('supports detail-less events', () => {
		const handler = vi.fn();
		const unsubscribe = onEditorEvent('rebuild', handler);

		emitEditorEvent('rebuild');

		expect(handler).toHaveBeenCalledTimes(1);
		unsubscribe();
	});

	it('stops delivering after unsubscribe', () => {
		const handler = vi.fn();
		const unsubscribe = onEditorEvent('preview-refresh', handler);

		emitEditorEvent('preview-refresh');
		unsubscribe();
		emitEditorEvent('preview-refresh');

		expect(handler).toHaveBeenCalledTimes(1);
	});

	it('interoperates with raw CustomEvents dispatched on globalThis', () => {
		const handler = vi.fn();
		const unsubscribe = onEditorEvent('server-logs', handler);

		// Existing tests/codepaths may dispatch raw CustomEvents directly.
		globalThis.dispatchEvent(new CustomEvent('server-logs', { detail: [{ level: 'info', message: 'hi', timestamp: 1 }] }));

		expect(handler).toHaveBeenCalledTimes(1);
		unsubscribe();
	});
});
