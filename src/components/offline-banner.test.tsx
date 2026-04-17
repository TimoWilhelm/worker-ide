import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useOnlineStatus } from '@/hooks/use-online-status';

import { OfflineBanner } from './offline-banner';

vi.mock('@/hooks/use-online-status', () => ({
	useOnlineStatus: vi.fn(),
}));

describe('OfflineBanner', () => {
	it('does not render while online', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(true);

		render(<OfflineBanner />);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('renders as a fixed bottom banner while offline', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(false);

		render(<OfflineBanner />);

		const alert = screen.getByRole('alert');
		expect(alert).toHaveTextContent('You are offline. Some features may not work until your connection is restored.');
		expect(alert.parentElement).toHaveClass('fixed', 'bottom-0');
	});
});
