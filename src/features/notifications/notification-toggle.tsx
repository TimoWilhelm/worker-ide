/**
 * Notification Toggle Button
 *
 * Bell icon button for enabling/disabling push notifications.
 * Placed in the IDE header next to the theme toggle.
 */

import { Bell, BellOff, BellRing } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { toast } from '@/components/ui/toast-store';
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

	// Permission denied — show disabled-looking bell that explains how to unblock
	if (permissionState === 'denied') {
		return (
			<Tooltip content="Notifications blocked">
				<Button
					variant="ghost"
					size="icon"
					aria-label="Notifications blocked"
					onClick={() => toast.info('Allow notifications for this site, then reload the page.')}
				>
					<BellOff className="size-4 text-text-secondary" />
				</Button>
			</Tooltip>
		);
	}

	const tooltipContent = isSubscribed ? 'Notifications enabled' : 'Notifications disabled';

	return (
		<Tooltip content={tooltipContent}>
			<Button variant="ghost" size="icon" aria-label={tooltipContent} onClick={handleClick} disabled={isLoading}>
				{isSubscribed ? <BellRing className={cn('size-4', 'text-accent')} /> : <Bell className="size-4" />}
			</Button>
		</Tooltip>
	);
}
