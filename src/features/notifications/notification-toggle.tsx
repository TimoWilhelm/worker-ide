/**
 * Notification Toggle Button
 *
 * Bell icon button for enabling/disabling push notifications.
 * Placed in the IDE header next to the theme toggle.
 */

import { Bell, BellOff, BellRing } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { usePushNotifications } from '@/hooks/use-push-notifications';
import { cn } from '@/lib/utils';

export function NotificationToggle() {
	const { permissionState, isSubscribed, isLoading, subscribe, unsubscribe } = usePushNotifications();

	// Don't render if push is not supported
	// eslint-disable-next-line unicorn/no-null -- React expects null for "render nothing"
	if (permissionState === 'unsupported') return null;

	function handleClick() {
		if (isSubscribed) {
			void unsubscribe();
		} else {
			void subscribe();
		}
	}

	// Permission denied — show disabled bell
	if (permissionState === 'denied') {
		return (
			<Tooltip content="Notifications blocked by browser">
				<Button variant="ghost" size="icon" aria-label="Notifications blocked" disabled>
					<BellOff className="size-4 text-text-secondary" />
				</Button>
			</Tooltip>
		);
	}

	const tooltipContent = isSubscribed ? 'Notifications enabled' : 'Enable notifications';

	return (
		<Tooltip content={tooltipContent}>
			<Button variant="ghost" size="icon" aria-label={tooltipContent} onClick={handleClick} disabled={isLoading}>
				{isSubscribed ? <BellRing className={cn('size-4', 'text-accent')} /> : <Bell className="size-4" />}
			</Button>
		</Tooltip>
	);
}
