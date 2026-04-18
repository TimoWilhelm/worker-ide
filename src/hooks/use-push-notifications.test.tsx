import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { usePushNotifications } from './use-push-notifications';

const {
	pushNotificationPreferenceGet,
	pushNotificationPreferencePut,
	pushSubscriptionDelete,
	pushSubscriptionPost,
	pushVapidKeyGet,
	toastError,
} = vi.hoisted(() => ({
	pushNotificationPreferenceGet: vi.fn(),
	pushNotificationPreferencePut: vi.fn(),
	pushSubscriptionDelete: vi.fn(),
	pushSubscriptionPost: vi.fn(),
	pushVapidKeyGet: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: toastError,
	},
}));

vi.mock('@/lib/api-client', () => ({
	createUserApiClient: () => ({
		user: {
			'push-notification-preference': {
				$get: pushNotificationPreferenceGet,
				$put: pushNotificationPreferencePut,
			},
			'push-subscription': {
				$post: pushSubscriptionPost,
				$delete: pushSubscriptionDelete,
			},
			'push-vapid-key': {
				$get: pushVapidKeyGet,
			},
		},
	}),
}));

interface MockPermissionStatus {
	state: PermissionState;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
}

describe('usePushNotifications', () => {
	const originalNotification = globalThis.Notification;
	const originalPushManager = globalThis.PushManager;
	const originalServiceWorker = navigator.serviceWorker;
	const originalPermissions = navigator.permissions;

	let permissionStatus: MockPermissionStatus;
	let permissionChangeListener: EventListener | undefined;
	let notificationPermission: NotificationPermission;
	let requestPermissionMock: ReturnType<typeof vi.fn>;
	let getSubscriptionMock: ReturnType<typeof vi.fn>;
	let subscribeMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		toastError.mockReset();
		pushNotificationPreferenceGet.mockReset();
		pushNotificationPreferencePut.mockReset();
		pushSubscriptionDelete.mockReset();
		pushSubscriptionPost.mockReset();
		pushVapidKeyGet.mockReset();
		permissionChangeListener = undefined;
		notificationPermission = 'default';
		requestPermissionMock = vi.fn();
		getSubscriptionMock = vi.fn(async () => {});
		subscribeMock = vi.fn();

		permissionStatus = {
			state: 'prompt',
			addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && typeof listener === 'function') {
					permissionChangeListener = listener;
				}
			}),
			removeEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && listener === permissionChangeListener) {
					permissionChangeListener = undefined;
				}
			}),
		};

		pushVapidKeyGet.mockResolvedValue({
			ok: true,
			json: async () => ({ key: 'vapid-key' }),
		});
		pushSubscriptionPost.mockResolvedValue({ ok: true });

		Object.defineProperty(globalThis, 'Notification', {
			configurable: true,
			value: {
				requestPermission: requestPermissionMock,
				get permission() {
					return notificationPermission;
				},
			},
		});
		Object.defineProperty(globalThis, 'PushManager', {
			configurable: true,
			value: class MockPushManager {},
		});
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: {
				ready: Promise.resolve({
					pushManager: {
						getSubscription: getSubscriptionMock,
						subscribe: subscribeMock,
					},
				}),
			},
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: {
				query: vi.fn(async () => permissionStatus),
			},
		});
	});

	afterEach(() => {
		Object.defineProperty(globalThis, 'Notification', {
			configurable: true,
			value: originalNotification,
		});
		Object.defineProperty(globalThis, 'PushManager', {
			configurable: true,
			value: originalPushManager,
		});
		Object.defineProperty(navigator, 'serviceWorker', {
			configurable: true,
			value: originalServiceWorker,
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: originalPermissions,
		});
	});

	it('does not show approval as pending before subscribe is requested', async () => {
		const { result } = renderHook(() => usePushNotifications());

		await waitFor(() => {
			expect(result.current.permissionState).toBe('default');
		});

		expect(result.current.needsPermissionApproval).toBe(false);
	});

	it('shows approval as pending only while the browser notification prompt is open', async () => {
		let resolvePermission: ((value: NotificationPermission) => void) | undefined;
		requestPermissionMock.mockImplementation(
			() =>
				new Promise<NotificationPermission>((resolve) => {
					resolvePermission = resolve;
				}),
		);

		const { result } = renderHook(() => usePushNotifications());

		await act(async () => {
			void result.current.subscribe();
		});

		await waitFor(() => {
			expect(result.current.needsPermissionApproval).toBe(true);
		});

		notificationPermission = 'default';
		permissionStatus.state = 'prompt';
		await act(async () => {
			resolvePermission?.('default');
		});

		await waitFor(() => {
			expect(result.current.needsPermissionApproval).toBe(false);
			expect(result.current.permissionState).toBe('default');
		});
	});

	it('updates when notification permission changes without a reload', async () => {
		const { result } = renderHook(() => usePushNotifications());

		await waitFor(() => {
			expect(permissionStatus.addEventListener).toHaveBeenCalled();
		});

		notificationPermission = 'denied';
		permissionStatus.state = 'denied';
		await act(async () => {
			permissionChangeListener?.(new Event('change'));
		});

		await waitFor(() => {
			expect(result.current.permissionState).toBe('denied');
		});
	});
});
