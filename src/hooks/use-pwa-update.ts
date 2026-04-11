import { useEffect, useRef } from 'react';
import { useRegisterSW } from 'virtual:pwa-register/react';

import { toast } from '@/components/ui/toast-store';

// Grace period to distinguish "new SW was already waiting on page load"
// from "update arrived mid-session".
const INITIAL_LOAD_GRACE_PERIOD_MS = 2000;

export function usePwaUpdate() {
	const updateIntervalReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const isInitialLoadReference = useRef(true);

	const {
		needRefresh: [needRefresh],
		updateServiceWorker,
	} = useRegisterSW({
		onRegisteredSW(_swUrl, registration) {
			if (registration) {
				const intervalMs = 5 * 60 * 1000;
				updateIntervalReference.current = setInterval(async () => {
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
			void updateServiceWorker(true);
			return;
		}

		toast.info('New version available', {
			action: {
				label: 'Reload',
				onClick: () => updateServiceWorker(true),
			},
		});
	}, [needRefresh, updateServiceWorker]);
}
