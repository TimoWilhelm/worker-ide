/**
 * Push Notifications Hook
 *
 * Manages the browser Push API subscription lifecycle and per-device
 * notification preference (enabled/disabled), decoupled from the
 * underlying push subscription:
 * - Checks permission state and existing subscription
 * - Subscribes/unsubscribes via the service worker's pushManager
 * - Registers/unregisters with the backend via API routes
 * - Toggles per-device notification preference independently
 *
 * On mount, detects and silently recovers from inconsistencies where the
 * browser has a push subscription but the backend KV entry is missing
 * (e.g. the push service deleted it after a NOT_SUBSCRIBED response).
 */

import { useCallback, useEffect, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { createUserApiClient } from '@/lib/api-client';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

interface UsePushNotificationsResult {
	permissionState: PermissionState;
	isSubscribed: boolean;
	isEnabled: boolean;
	isLoading: boolean;
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

	// Check existing subscription and preference on mount.
	// If the browser has a push subscription but the backend has no record
	// (KV entry deleted by queue consumer), silently clean up the stale
	// browser subscription so the UI stays consistent.
	useEffect(() => {
		if (!isPushSupported()) return;

		void (async () => {
			try {
				const subscription = await getPushSubscription();
				if (!subscription?.endpoint) return;

				const preferenceResponse = await userApi.user['push-notification-preference'].$get({
					query: { endpoint: subscription.endpoint },
				});

				if (!preferenceResponse.ok) {
					// Backend doesn't recognise this subscription — silently clean up
					await subscription.unsubscribe();
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
		})();
	}, []);

	const subscribe = useCallback(async () => {
		if (!isPushSupported()) return;
		setIsLoading(true);

		try {
			// 1. Fetch VAPID public key from the backend
			const vapidResponse = await userApi.user['push-vapid-key'].$get({});
			if (!vapidResponse.ok) {
				throw new Error('Failed to fetch VAPID key');
			}
			const { key: vapidPublicKey } = await vapidResponse.json();

			// 2. Request notification permission
			const permission = await Notification.requestPermission();
			setPermissionState(permission);
			if (permission !== 'granted') return;

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

	return { permissionState, isSubscribed, isEnabled, isLoading, subscribe, unsubscribe, toggleEnabled };
}
