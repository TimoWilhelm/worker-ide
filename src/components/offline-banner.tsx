/**
 * Offline Banner
 *
 * Displays a persistent banner at the top of the viewport when the browser
 * reports that the network connection is unavailable (`navigator.onLine === false`).
 */

import { WifiOff } from 'lucide-react';

import { useOnlineStatus } from '@/hooks/use-online-status';

export function OfflineBanner() {
	const isOnline = useOnlineStatus();

	if (isOnline) {
		return;
	}

	return (
		<div
			role="alert"
			className="
				flex shrink-0 items-center justify-center gap-2 bg-error px-3 py-1.5 text-xs
				font-medium text-white
			"
		>
			<WifiOff className="size-3.5 shrink-0" />
			You are offline. Some features may not work until your connection is restored.
		</div>
	);
}
