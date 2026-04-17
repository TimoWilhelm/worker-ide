import { WifiOff } from 'lucide-react';

import { useOnlineStatus } from '@/hooks/use-online-status';

export function OfflineBanner() {
	const isOnline = useOnlineStatus();

	if (isOnline) {
		return;
	}

	return (
		<div
			className="
				pointer-events-none fixed inset-x-0 bottom-0 z-60 flex justify-center p-3
				safe-area-b
			"
		>
			<div
				role="alert"
				className="
					pointer-events-auto flex max-w-md items-center gap-2 rounded-full bg-error
					px-4 py-2 text-xs font-medium text-white shadow-lg
				"
			>
				<WifiOff className="size-3.5 shrink-0" />
				<span className="text-center">You are offline. Some features may not work until your connection is restored.</span>
			</div>
		</div>
	);
}
