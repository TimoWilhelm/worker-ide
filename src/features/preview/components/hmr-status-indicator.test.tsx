import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HmrStatusIndicator } from './hmr-status-indicator';

const mockIsMessageFromPreview = vi.fn();

vi.mock('@/lib/preview-origin', () => ({
	isMessageFromPreview: (event: MessageEvent) => mockIsMessageFromPreview(event),
}));

function dispatchStatus(status: string) {
	act(() => {
		globalThis.dispatchEvent(new MessageEvent('message', { data: { type: '__hmr-status', status } }));
	});
}

describe('HmrStatusIndicator', () => {
	beforeEach(() => {
		mockIsMessageFromPreview.mockReturnValue(true);
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.runOnlyPendingTimers();
		vi.useRealTimers();
		vi.clearAllMocks();
	});

	it('renders nothing until a status arrives', () => {
		render(<HmrStatusIndicator />);
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
	});

	it('shows the connected status', () => {
		render(<HmrStatusIndicator />);
		dispatchStatus('connected');
		expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'HMR connected');
	});

	it('shows the error status', () => {
		render(<HmrStatusIndicator />);
		dispatchStatus('error');
		expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Build error');
	});

	it('reverts from updated back to connected after the reset delay', () => {
		render(<HmrStatusIndicator />);
		dispatchStatus('updated');
		expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'Hot updated');

		act(() => {
			vi.advanceTimersByTime(1500);
		});

		expect(screen.getByRole('status')).toHaveAttribute('aria-label', 'HMR connected');
	});

	it('ignores messages that are not from the preview', () => {
		mockIsMessageFromPreview.mockReturnValue(false);
		render(<HmrStatusIndicator />);
		dispatchStatus('connected');
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
	});

	it('ignores unknown status values', () => {
		render(<HmrStatusIndicator />);
		dispatchStatus('bogus');
		expect(screen.queryByRole('status')).not.toBeInTheDocument();
	});
});
