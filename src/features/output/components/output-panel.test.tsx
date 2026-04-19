import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

const mockOpenFileTarget = vi.fn();
let logs: Array<{ id: string; level: 'error'; message: string; source: 'client'; timestamp: number }> = [];

vi.mock('../lib/log-buffer', () => ({
	useLogs: () => logs,
	clearLogs: vi.fn(),
	getPreserveLogs: () => false,
	setPreserveLogs: vi.fn(),
}));

vi.mock('@/lib/file-target', () => ({
	useFileTargetOpener: () => mockOpenFileTarget,
}));

import { OutputPanel } from './output-panel';

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('OutputPanel accessibility', () => {
	beforeEach(() => {
		logs = [];
		vi.clearAllMocks();
	});

	it('renders filter buttons inside a radiogroup', () => {
		renderWithProviders(<OutputPanel projectId="test" />);

		const radiogroup = screen.getByRole('radiogroup', { name: 'Log filter' });
		expect(radiogroup).toBeInTheDocument();
	});

	it('filter buttons have role="radio" and aria-checked', () => {
		renderWithProviders(<OutputPanel projectId="test" />);

		const radios = screen.getAllByRole('radio');
		expect(radios).toHaveLength(4);

		const allButton = screen.getByRole('radio', { name: 'All' });
		expect(allButton).toHaveAttribute('aria-checked', 'true');

		const serverButton = screen.getByRole('radio', { name: 'Server' });
		expect(serverButton).toHaveAttribute('aria-checked', 'false');

		const clientButton = screen.getByRole('radio', { name: 'Client' });
		expect(clientButton).toHaveAttribute('aria-checked', 'false');
	});

	it('clicking a filter button updates aria-checked', async () => {
		renderWithProviders(<OutputPanel projectId="test" />);

		const serverButton = screen.getByRole('radio', { name: 'Server' });
		await userEvent.click(serverButton);

		expect(serverButton).toHaveAttribute('aria-checked', 'true');

		const allButton = screen.getByRole('radio', { name: 'All' });
		expect(allButton).toHaveAttribute('aria-checked', 'false');
	});

	it('preserve button has aria-pressed', () => {
		renderWithProviders(<OutputPanel projectId="test" />);

		const preserveButton = screen.getByRole('button', { name: 'Preserve' });
		expect(preserveButton).toHaveAttribute('aria-pressed', 'false');
	});

	it('clear logs button has an accessible name', () => {
		renderWithProviders(<OutputPanel projectId="test" />);

		expect(screen.getByLabelText('Clear logs')).toBeInTheDocument();
	});

	it('opens file references through the shared file target opener', async () => {
		logs = [
			{
				id: '1',
				level: 'error',
				message: 'at src/main.ts:10:7',
				source: 'client',
				timestamp: Date.now(),
			},
		];

		renderWithProviders(<OutputPanel projectId="test" />);

		await userEvent.click(screen.getByRole('button', { name: 'at src/main.ts:10:7' }));

		expect(mockOpenFileTarget).toHaveBeenCalledWith({ path: 'src/main.ts', position: { line: 10, column: 7 } });
	});
});
