/**
 * Component tests for TerminalPanel accessibility.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

const EMPTY_LOGS: never[] = [];

vi.mock('../lib/log-buffer', () => ({
	subscribeToLogs: (listener: () => void) => {
		return () => {
			void listener;
		};
	},
	getLogSnapshot: () => EMPTY_LOGS,
	clearLogs: vi.fn(),
	getPreserveLogs: () => false,
	setPreserveLogs: vi.fn(),
}));

const noopFunction = () => {
	/* noop */
};

vi.mock('@/lib/store', () => ({
	useStore: () => noopFunction,
}));

import { TerminalPanel } from './terminal-panel';

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('TerminalPanel accessibility', () => {
	it('renders filter buttons inside a radiogroup', () => {
		renderWithProviders(<TerminalPanel projectId="test" />);

		const radiogroup = screen.getByRole('radiogroup', { name: 'Log filter' });
		expect(radiogroup).toBeInTheDocument();
	});

	it('filter buttons have role="radio" and aria-checked', () => {
		renderWithProviders(<TerminalPanel projectId="test" />);

		const radios = screen.getAllByRole('radio');
		expect(radios).toHaveLength(3);

		const allButton = screen.getByRole('radio', { name: 'All' });
		expect(allButton).toHaveAttribute('aria-checked', 'true');

		const serverButton = screen.getByRole('radio', { name: 'Server' });
		expect(serverButton).toHaveAttribute('aria-checked', 'false');

		const clientButton = screen.getByRole('radio', { name: 'Client' });
		expect(clientButton).toHaveAttribute('aria-checked', 'false');
	});

	it('clicking a filter button updates aria-checked', async () => {
		renderWithProviders(<TerminalPanel projectId="test" />);

		const serverButton = screen.getByRole('radio', { name: 'Server' });
		await userEvent.click(serverButton);

		expect(serverButton).toHaveAttribute('aria-checked', 'true');

		const allButton = screen.getByRole('radio', { name: 'All' });
		expect(allButton).toHaveAttribute('aria-checked', 'false');
	});

	it('preserve button has aria-pressed', () => {
		renderWithProviders(<TerminalPanel projectId="test" />);

		const preserveButton = screen.getByRole('button', { name: 'Preserve' });
		expect(preserveButton).toHaveAttribute('aria-pressed', 'false');
	});

	it('clear logs button has an accessible name', () => {
		renderWithProviders(<TerminalPanel projectId="test" />);

		expect(screen.getByLabelText('Clear logs')).toBeInTheDocument();
	});
});
