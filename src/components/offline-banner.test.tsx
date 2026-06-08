import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { useOnlineStatus } from '@/hooks/use-online-status';
import { useSaveQueueCount } from '@/hooks/use-save-queue-count';

import { OfflineBanner } from './offline-banner';

vi.mock('@/hooks/use-online-status', () => ({
	useOnlineStatus: vi.fn(),
}));

vi.mock('@/hooks/use-save-queue-count', () => ({
	useSaveQueueCount: vi.fn(),
}));

describe('OfflineBanner', () => {
	it('does not render while online', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(true);
		vi.mocked(useSaveQueueCount).mockReturnValue(0);

		render(<OfflineBanner />);

		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('renders as a fixed bottom banner while offline', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(false);
		vi.mocked(useSaveQueueCount).mockReturnValue(0);

		render(<OfflineBanner />);

		const alert = screen.getByRole('alert');
		expect(alert).toHaveTextContent('You are offline. Cached files remain editable; saves will queue until your connection is restored.');
		expect(alert.parentElement).toHaveClass('fixed', 'bottom-0');
	});

	it('shows queued save count while offline', () => {
		vi.mocked(useOnlineStatus).mockReturnValue(false);
		vi.mocked(useSaveQueueCount).mockReturnValue(2);

		render(<OfflineBanner />);

		expect(screen.getByRole('alert')).toHaveTextContent('2 saves queued and ready to sync when your connection is restored.');
	});
});
