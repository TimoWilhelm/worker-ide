import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('stale asset recovery', () => {
	const originalLocation = globalThis.location;
	const originalSessionStorage = globalThis.sessionStorage;
	let reloadMock: ReturnType<typeof vi.fn>;
	let storage = new Map<string, string>();

	beforeEach(() => {
		vi.resetModules();
		storage = new Map<string, string>();
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			value: {
				clear() {
					storage.clear();
				},
				getItem(key: string) {
					return storage.get(key) ?? undefined;
				},
				removeItem(key: string) {
					storage.delete(key);
				},
				setItem(key: string, value: string) {
					storage.set(key, value);
				},
			},
		});
		globalThis.sessionStorage.clear();
		reloadMock = vi.fn();
		Object.defineProperty(globalThis, 'location', {
			configurable: true,
			value: {
				...originalLocation,
				reload: reloadMock,
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'location', {
			configurable: true,
			value: originalLocation,
		});
		globalThis.sessionStorage.clear();
		Object.defineProperty(globalThis, 'sessionStorage', {
			configurable: true,
			value: originalSessionStorage,
		});
	});

	it('recognizes dynamic import failure messages across browser variants', async () => {
		const { isDynamicImportFailure } = await import('./stale-asset-recovery');

		expect(isDynamicImportFailure(new Error('Failed to fetch dynamically imported module'))).toBe(true);
		expect(isDynamicImportFailure({ message: 'Importing a module script failed' })).toBe(true);
		expect(isDynamicImportFailure({ reason: { message: 'error loading dynamically imported module' } })).toBe(true);
		expect(isDynamicImportFailure(new Error('Plain application error'))).toBe(false);
	});

	it('reloads at most once within the recovery window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T20:00:00Z'));
		const { recoverFromStaleAsset } = await import('./stale-asset-recovery');

		expect(recoverFromStaleAsset()).toBe(true);
		expect(reloadMock).toHaveBeenCalledTimes(1);
		expect(globalThis.sessionStorage.getItem('stale-asset-reload')).toBe(String(Date.now()));

		expect(recoverFromStaleAsset()).toBe(false);
		expect(reloadMock).toHaveBeenCalledTimes(1);

		vi.setSystemTime(new Date('2026-05-05T20:00:11Z'));
		expect(recoverFromStaleAsset()).toBe(true);
		expect(reloadMock).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});

	it('tracks pending update activation reloads within the grace window', async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-05-05T20:00:00Z'));
		const { clearUpdateActivationReloadPending, isUpdateActivationReloadPending, markUpdateActivationReloadPending } =
			await import('./stale-asset-recovery');

		expect(isUpdateActivationReloadPending()).toBe(false);

		markUpdateActivationReloadPending();
		expect(isUpdateActivationReloadPending()).toBe(true);

		vi.setSystemTime(new Date('2026-05-05T20:00:31Z'));
		expect(isUpdateActivationReloadPending()).toBe(false);

		markUpdateActivationReloadPending();
		clearUpdateActivationReloadPending();
		expect(isUpdateActivationReloadPending()).toBe(false);

		vi.useRealTimers();
	});
});
