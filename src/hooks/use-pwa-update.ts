/**
 * PWA Update Hook
 *
 * Registers the service worker with prompt-based updates.
 * Periodically checks for new versions and shows a toast notification
 * with a "Reload" action when an update is available.
 */

import { useEffect } from 'react';
// eslint-disable-next-line import-x/no-unresolved
import { useRegisterSW } from 'virtual:pwa-register/react';

import { toast } from '@/components/ui/toast-store';

export function usePwaUpdate() {
	const {
		needRefresh: [needRefresh],
		updateServiceWorker,
	} = useRegisterSW({
		onRegisteredSW(_swUrl, registration) {
			if (registration) {
				const intervalMs = 5 * 60 * 1000;
				setInterval(async () => {
					if (!(!registration.installing && navigator)) return;

					if ('connection' in navigator && !navigator.onLine) return;

					const response = await fetch(_swUrl, {
						cache: 'no-store',
						headers: { cache: 'no-store' },
					});

					if (response.ok) {
						await registration.update();
					}
				}, intervalMs);
			}
		},
	});

	useEffect(() => {
		if (!needRefresh) return;

		toast.info('New version available', {
			action: {
				label: 'Reload',
				onClick: () => updateServiceWorker(true),
			},
		});
	}, [needRefresh, updateServiceWorker]);
}
