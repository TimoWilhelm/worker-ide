import { useCallback, useEffect, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { createUserApiClient } from '@/lib/api-client';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

interface UsePushNotificationsResult {
	permissionState: PermissionState;
	isSubscribed: boolean;
	isEnabled: boolean;
	isLoading: boolean;
	needsPermissionApproval: boolean;
	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
	toggleEnabled: () => Promise<void>;
}

const userApi = createUserApiClient();

function isPushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
}

function getPermissionState(): PermissionState {
	if (!isPushSupported()) return 'unsupported';
	return Notification.permission;
}

async function getPushSubscription(): Promise<PushSubscription | undefined> {
	try {
		const registration = await navigator.serviceWorker.ready;
		const subscription = await registration.pushManager.getSubscription();
		return subscription ?? undefined;
	} catch {
		return undefined;
	}
}

export function usePushNotifications(): UsePushNotificationsResult {
	const [permissionState, setPermissionState] = useState<PermissionState>(getPermissionState);
	const [isSubscribed, setIsSubscribed] = useState(false);
	const [isEnabled, setIsEnabled] = useState(false);
	const [isLoading, setIsLoading] = useState(false);
	const [isAwaitingPermission, setIsAwaitingPermission] = useState(false);

	const syncPushState = useCallback(async () => {
		if (!isPushSupported()) return;

		setPermissionState(getPermissionState());

		try {
			const subscription = await getPushSubscription();
			if (!subscription?.endpoint) {
				setIsSubscribed(false);
				setIsEnabled(false);
				return;
			}

			const preferenceResponse = await userApi.user['push-notification-preference'].$get({
				query: { endpoint: subscription.endpoint },
			});

			if (!preferenceResponse.ok) {
				// Backend doesn't recognise this subscription — silently clean up
				await subscription.unsubscribe();
				setIsSubscribed(false);
				setIsEnabled(false);
				return;
			}

			const { enabled } = await preferenceResponse.json();

			// The backend returned enabled: false AND no KV entry existed,
			// the route defaults to { enabled: false }. We can't distinguish
			// "entry exists with enabled=false" from "entry missing" here,
			// so we trust the backend response and show the correct state.
			setIsSubscribed(true);
			setIsEnabled(enabled);
		} catch {
			// Service worker not ready yet — ignore
		}
	}, []);

	useEffect(() => {
		if (!isPushSupported()) return;

		void Promise.resolve().then(syncPushState);

		const handlePermissionChange = () => {
			setIsAwaitingPermission(false);
			void syncPushState();
		};
		const handleWindowFocus = () => {
			void syncPushState();
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState !== 'visible') return;
			void syncPushState();
		};

		window.addEventListener('focus', handleWindowFocus);
		document.addEventListener('visibilitychange', handleVisibilityChange);

		let permissionStatus: PermissionStatus | undefined;
		if ('permissions' in navigator) {
			void navigator.permissions
				.query({ name: 'notifications' })
				.then((status) => {
					permissionStatus = status;
					status.addEventListener('change', handlePermissionChange);
				})
				.catch(() => {
					// Permissions API unsupported — fall back to focus/visibility sync.
				});
		}

		return () => {
			window.removeEventListener('focus', handleWindowFocus);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
			permissionStatus?.removeEventListener('change', handlePermissionChange);
		};
	}, [syncPushState]);

	const subscribe = useCallback(async () => {
		if (!isPushSupported()) return;
		setIsLoading(true);
		setIsAwaitingPermission(getPermissionState() === 'default');

		try {
			// 1. Request notification permission
			const permission = await Notification.requestPermission();
			setPermissionState(permission);
			setIsAwaitingPermission(false);
			if (permission !== 'granted') return;

			// 2. Fetch VAPID public key from the backend
			const vapidResponse = await userApi.user['push-vapid-key'].$get({});
			if (!vapidResponse.ok) {
				throw new Error('Failed to fetch VAPID key');
			}
			const { key: vapidPublicKey } = await vapidResponse.json();

			// 3. Subscribe via the service worker's pushManager
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.subscribe({
				userVisibleOnly: true,
				applicationServerKey: vapidPublicKey,
			});

			// 4. Extract subscription details and send to the backend
			const subscriptionJson = subscription.toJSON();
			const p256dhKey = subscriptionJson.keys?.p256dh;
			const authKey = subscriptionJson.keys?.auth;

			if (!subscription.endpoint || !p256dhKey || !authKey) {
				throw new Error('Invalid push subscription: missing required fields');
			}

			const registerResponse = await userApi.user['push-subscription'].$post({
				json: {
					endpoint: subscription.endpoint,
					key: p256dhKey,
					auth: authKey,
				},
			});

			if (!registerResponse.ok) {
				throw new Error('Failed to register push subscription');
			}

			setIsSubscribed(true);
			setIsEnabled(true);
		} catch {
			toast.error('Could not enable notifications. Please check your browser permissions and try again.');
		} finally {
			setIsAwaitingPermission(false);
			setIsLoading(false);
		}
	}, []);

	const unsubscribe = useCallback(async () => {
		if (!isPushSupported()) return;
		setIsLoading(true);

		try {
			const subscription = await getPushSubscription();

			if (subscription) {
				// 1. Unsubscribe from push manager
				await subscription.unsubscribe();

				// 2. Remove from backend (also removes preference)
				await userApi.user['push-subscription'].$delete({
					json: { endpoint: subscription.endpoint },
				});
			}

			setIsSubscribed(false);
			setIsEnabled(false);
		} catch {
			toast.error('Could not disable notifications. Please try again.');
		} finally {
			setIsLoading(false);
		}
	}, []);

	const toggleEnabled = useCallback(async () => {
		if (!isPushSupported()) return;
		setIsLoading(true);

		try {
			const subscription = await getPushSubscription();
			if (!subscription?.endpoint) return;

			const newEnabled = !isEnabled;
			const response = await userApi.user['push-notification-preference'].$put({
				json: { endpoint: subscription.endpoint, enabled: newEnabled },
			});

			if (!response.ok) {
				throw new Error('Failed to update notification preference');
			}

			setIsEnabled(newEnabled);
		} catch {
			toast.error('Could not update notification preference. Please try again.');
		} finally {
			setIsLoading(false);
		}
	}, [isEnabled]);

	return {
		permissionState,
		isSubscribed,
		isEnabled,
		isLoading,
		needsPermissionApproval: isAwaitingPermission,
		subscribe,
		unsubscribe,
		toggleEnabled,
	};
}
