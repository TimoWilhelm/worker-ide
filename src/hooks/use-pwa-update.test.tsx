import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { markUpdateActivationReloadPendingMock, recoverFromStaleAssetMock, toastInfoMock, updateServiceWorkerMock, useRegisterSWMock } =
	vi.hoisted(() => ({
		markUpdateActivationReloadPendingMock: vi.fn(),
		recoverFromStaleAssetMock: vi.fn(),
		toastInfoMock: vi.fn(),
		updateServiceWorkerMock: vi.fn(),
		useRegisterSWMock: vi.fn(),
	}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		info: toastInfoMock,
	},
}));

vi.mock('@/lib/stale-asset-recovery', () => ({
	markUpdateActivationReloadPending: markUpdateActivationReloadPendingMock,
	recoverFromStaleAsset: recoverFromStaleAssetMock,
}));

vi.mock('@/lib/pwa-register', () => ({
	useRegisterSW: useRegisterSWMock,
}));

interface MockServiceWorkerRegistration {
	update: () => Promise<void>;
	installing: undefined;
}

interface RegisterSWOptions {
	onRegisteredSW?: (swUrl: string, registration?: MockServiceWorkerRegistration) => void;
}

describe('usePwaUpdate', () => {
	const originalServiceWorker = navigator.serviceWorker;
	let controllerChangeListener: EventListener | undefined;
	let registrationUpdateMock: ReturnType<typeof vi.fn>;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		vi.resetModules();
		vi.useFakeTimers();
		toastInfoMock.mockReset();
		markUpdateActivationReloadPendingMock.mockReset();
		recoverFromStaleAssetMock.mockReset();
		updateServiceWorkerMock.mockReset();
		registrationUpdateMock = vi.fn(async () => {});
		fetchMock = vi.fn(async () => new Response(undefined, { status: 200 }));
		controllerChangeListener = undefined;
		vi.stubGlobal('fetch', fetchMock);

		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: {
				addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
					if (eventName === 'controllerchange' && typeof listener === 'function') {
						controllerChangeListener = listener;
					}
				}),
				removeEventListener: vi.fn(),
			},
		});

		useRegisterSWMock.mockImplementation((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [false, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: originalServiceWorker,
		});
	});

	it('activates immediately during the initial-load grace period and reloads after controller change', async () => {
		useRegisterSWMock.mockImplementationOnce((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [true, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());

		expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
		expect(markUpdateActivationReloadPendingMock).toHaveBeenCalledTimes(1);
		expect(toastInfoMock).not.toHaveBeenCalled();
		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			controllerChangeListener?.(new Event('controllerchange'));
		});

		expect(recoverFromStaleAssetMock).toHaveBeenCalledTimes(1);
	});

	it('shows a reload toast after the grace period and reloads after activating the waiting worker', async () => {
		useRegisterSWMock.mockImplementationOnce((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [false, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		const { usePwaUpdate } = await import('./use-pwa-update');
		const { rerender } = renderHook(() => usePwaUpdate());

		act(() => {
			vi.advanceTimersByTime(2001);
		});

		useRegisterSWMock.mockImplementation((options?: RegisterSWOptions) => {
			options?.onRegisteredSW?.('/sw.js', {
				update: registrationUpdateMock,
				installing: undefined,
			});

			return {
				needRefresh: [true, vi.fn()],
				updateServiceWorker: updateServiceWorkerMock,
			};
		});

		rerender();

		expect(toastInfoMock).toHaveBeenCalledTimes(1);
		const toastCall = toastInfoMock.mock.calls[0];
		expect(toastCall).toBeDefined();
		if (!toastCall) {
			throw new Error('Expected toast call to be defined');
		}

		const toastOptions = toastCall[1];
		expect(toastCall[0]).toBe('New version available');
		expect(toastOptions).toMatchObject({ persist: true });
		expect(toastOptions?.action).toBeDefined();
		if (!toastOptions?.action) {
			throw new Error('Expected toast action to be defined');
		}

		await act(async () => {
			toastOptions.action.onClick();
		});

		expect(updateServiceWorkerMock).toHaveBeenCalledWith(true);
		expect(markUpdateActivationReloadPendingMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			controllerChangeListener?.(new Event('controllerchange'));
		});

		expect(recoverFromStaleAssetMock).toHaveBeenCalledTimes(1);
	});

	it('ignores service worker polling fetch failures', async () => {
		const rejectionError = new Error('Network unavailable');
		fetchMock.mockRejectedValue(rejectionError);

		const { usePwaUpdate } = await import('./use-pwa-update');
		renderHook(() => usePwaUpdate());

		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);

		await act(async () => {
			vi.advanceTimersByTime(5 * 60 * 1000);
			await Promise.resolve();
		});

		expect(fetchMock).toHaveBeenCalledWith('/sw.js', {
			cache: 'no-store',
			headers: { cache: 'no-store' },
		});
		expect(registrationUpdateMock).toHaveBeenCalledTimes(1);
	});
});
