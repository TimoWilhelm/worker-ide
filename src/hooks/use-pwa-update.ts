import { useCallback, useEffect, useRef } from 'react';

import { toast } from '@/components/ui/toast-store';
import { useRegisterSW } from '@/lib/pwa-register';
import { markUpdateActivationReloadPending, recoverFromStaleAsset } from '@/lib/stale-asset-recovery';

// Grace period to distinguish "new SW was already waiting on page load"
// from "update arrived mid-session".
const INITIAL_LOAD_GRACE_PERIOD_MS = 2000;

export function usePwaUpdate() {
	const updateIntervalReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const isInitialLoadReference = useRef(true);
	const isAwaitingActivationReloadReference = useRef(false);

	useEffect(() => {
		function handleControllerChange() {
			if (!isAwaitingActivationReloadReference.current) {
				return;
			}

			isAwaitingActivationReloadReference.current = false;
			recoverFromStaleAsset();
		}

		navigator.serviceWorker?.addEventListener('controllerchange', handleControllerChange);
		return () => {
			navigator.serviceWorker?.removeEventListener('controllerchange', handleControllerChange);
		};
	}, []);

	const {
		needRefresh: [needRefresh],
		updateServiceWorker,
	} = useRegisterSW({
		onRegisteredSW(_swUrl, registration) {
			if (registration) {
				void registration.update();
				const intervalMs = 5 * 60 * 1000;
				updateIntervalReference.current = setInterval(async () => {
					if (!(!registration.installing && navigator)) return;

					if ('connection' in navigator && !navigator.onLine) return;

					try {
						const response = await fetch(_swUrl, {
							cache: 'no-store',
							headers: { cache: 'no-store' },
						});

						if (!response.ok) {
							return;
						}

						await registration.update();
					} catch {
						return;
					}
				}, intervalMs);
			}
		},
	});

	const activateUpdate = useCallback(() => {
		isAwaitingActivationReloadReference.current = true;
		markUpdateActivationReloadPending();
		void updateServiceWorker(true);
	}, [updateServiceWorker]);

	useEffect(() => {
		const timeout = setTimeout(() => {
			isInitialLoadReference.current = false;
		}, INITIAL_LOAD_GRACE_PERIOD_MS);
		return () => clearTimeout(timeout);
	}, []);

	useEffect(() => {
		return () => {
			clearInterval(updateIntervalReference.current);
		};
	}, []);

	useEffect(() => {
		if (!needRefresh) return;

		// Non-disruptive: silently activate during initial load
		if (isInitialLoadReference.current) {
			activateUpdate();
			return;
		}

		toast.info('New version available', {
			persist: true,
			action: {
				label: 'Reload',
				onClick: activateUpdate,
			},
		});
	}, [activateUpdate, needRefresh]);
}
