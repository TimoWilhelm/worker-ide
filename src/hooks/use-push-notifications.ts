/**
 * Push Notifications Hook
 *
 * Manages the browser Push API subscription lifecycle:
 * - Checks permission state and existing subscription
 * - Subscribes/unsubscribes via the service worker's pushManager
 * - Registers/unregisters with the backend via API routes
 */

import { useCallback, useEffect, useState } from 'react';

import { toast } from '@/components/ui/toast-store';

type PermissionState = 'default' | 'granted' | 'denied' | 'unsupported';

interface UsePushNotificationsResult {
	permissionState: PermissionState;
	isSubscribed: boolean;
	isLoading: boolean;
	subscribe: () => Promise<void>;
	unsubscribe: () => Promise<void>;
}

function isPushSupported(): boolean {
	return 'serviceWorker' in navigator && 'PushManager' in globalThis && 'Notification' in globalThis;
}

function getPermissionState(): PermissionState {
	if (!isPushSupported()) return 'unsupported';
	return Notification.permission;
}

export function usePushNotifications(): UsePushNotificationsResult {
	const [permissionState, setPermissionState] = useState<PermissionState>(getPermissionState);
	const [isSubscribed, setIsSubscribed] = useState(false);
	const [isLoading, setIsLoading] = useState(false);

	// Check existing subscription on mount
	useEffect(() => {
		if (!isPushSupported()) return;

		void (async () => {
			try {
				const registration = await navigator.serviceWorker.ready;
				const subscription = await registration.pushManager.getSubscription();
				setIsSubscribed(subscription !== null);
			} catch {
				// Service worker not ready yet
			}
		})();
	}, []);

	const subscribe = useCallback(async () => {
		if (!isPushSupported()) return;
		setIsLoading(true);

		try {
			// 1. Fetch VAPID public key from the backend
			const vapidResponse = await fetch('/api/user/push-vapid-key');
			if (!vapidResponse.ok) {
				throw new Error('Failed to fetch VAPID key');
			}
			const { key: vapidPublicKey }: { key: string } = await vapidResponse.json();

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

			const registerResponse = await fetch('/api/user/push-subscription', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					endpoint: subscription.endpoint,
					key: p256dhKey,
					auth: authKey,
				}),
			});

			if (!registerResponse.ok) {
				throw new Error('Failed to register push subscription');
			}

			setIsSubscribed(true);
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
			const registration = await navigator.serviceWorker.ready;
			const subscription = await registration.pushManager.getSubscription();

			if (subscription) {
				// 1. Unsubscribe from push manager
				await subscription.unsubscribe();

				// 2. Remove from backend
				await fetch('/api/user/push-subscription', {
					method: 'DELETE',
					headers: { 'Content-Type': 'application/json' },
					body: JSON.stringify({ endpoint: subscription.endpoint }),
				});
			}

			setIsSubscribed(false);
		} catch {
			toast.error('Could not disable notifications. Please try again.');
		} finally {
			setIsLoading(false);
		}
	}, []);

	return { permissionState, isSubscribed, isLoading, subscribe, unsubscribe };
}
