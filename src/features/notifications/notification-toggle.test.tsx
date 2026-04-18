import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { NotificationToggle } from './notification-toggle';

const { usePushNotificationsMock } = vi.hoisted(() => ({
	usePushNotificationsMock: vi.fn(),
}));

vi.mock('@/hooks/use-push-notifications', () => ({
	usePushNotifications: () => usePushNotificationsMock(),
}));

describe('NotificationToggle', () => {
	beforeEach(() => {
		usePushNotificationsMock.mockReset();
	});

	it('keeps the default notification button in its normal state before any prompt is shown', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'default',
			isSubscribed: false,
			isEnabled: false,
			isLoading: false,
			needsPermissionApproval: false,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Enable notifications' });
		expect(button).toBeInTheDocument();
		expect(button.querySelector('svg')).not.toHaveClass('animate-pulse');
	});

	it('shows a pulsing approval state only while the notification prompt is pending', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'default',
			isSubscribed: false,
			isEnabled: false,
			isLoading: false,
			needsPermissionApproval: true,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Approve notifications in your browser' });
		expect(button).toBeInTheDocument();
		expect(button.querySelector('svg')).toHaveClass('animate-pulse');
	});

	it('does not show the approval pulse after permission is denied', () => {
		usePushNotificationsMock.mockReturnValue({
			permissionState: 'denied',
			isSubscribed: false,
			isEnabled: false,
			isLoading: false,
			needsPermissionApproval: false,
			subscribe: vi.fn(),
			toggleEnabled: vi.fn(),
		});

		render(<NotificationToggle />);

		const button = screen.getByRole('button', { name: 'Notifications blocked' });
		expect(button).toBeInTheDocument();
		expect(button.querySelector('svg')).not.toHaveClass('animate-pulse');
	});
});
