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

	it('shows a pulsing approval state with tooltip text before notification permission is granted', () => {
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

		expect(screen.getByRole('button', { name: 'Approve notifications in your browser' })).toBeInTheDocument();
		expect(screen.getByTestId('pending-approval-indicator')).toBeInTheDocument();
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

		expect(screen.getByRole('button', { name: 'Notifications blocked' })).toBeInTheDocument();
		expect(screen.queryByTestId('pending-approval-indicator')).not.toBeInTheDocument();
	});
});
