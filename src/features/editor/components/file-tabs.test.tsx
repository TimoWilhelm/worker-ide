/**
 * Component tests for FileTabs.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { FileTabs } from './file-tabs';

const SAMPLE_TABS = [
	{ path: '/src/main.ts', hasUnsavedChanges: false },
	{ path: '/src/app.tsx', hasUnsavedChanges: true },
	{ path: '/styles/index.css', hasUnsavedChanges: false },
];

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('FileTabs', () => {
	it('renders tab labels from filenames', () => {
		renderWithProviders(<FileTabs tabs={SAMPLE_TABS} activeTab="/src/main.ts" onSelect={vi.fn()} onClose={vi.fn()} />);

		expect(screen.getByText('main.ts')).toBeInTheDocument();
		expect(screen.getByText('app.tsx')).toBeInTheDocument();
		expect(screen.getByText('index.css')).toBeInTheDocument();
	});

	it('renders empty state when no tabs', () => {
		renderWithProviders(<FileTabs tabs={[]} activeTab={undefined} onSelect={vi.fn()} onClose={vi.fn()} />);

		expect(screen.getByText('No files open')).toBeInTheDocument();
	});

	it('shows unsaved changes indicator', () => {
		renderWithProviders(<FileTabs tabs={SAMPLE_TABS} activeTab="/src/main.ts" onSelect={vi.fn()} onClose={vi.fn()} />);

		// The unsaved indicator is a small dot inside a tooltip trigger.
		// Only app.tsx has unsaved changes, so there should be exactly one dot.
		const unsavedDots = document.querySelectorAll('.rounded-full.bg-accent');
		expect(unsavedDots).toHaveLength(1);
	});

	it('calls onSelect when a tab is clicked', async () => {
		const onSelect = vi.fn();
		renderWithProviders(<FileTabs tabs={SAMPLE_TABS} activeTab="/src/main.ts" onSelect={onSelect} onClose={vi.fn()} />);

		// Use userEvent.click for full interaction sequence (pointerdown, mousedown, etc.)
		// which Radix Tabs requires for proper tab activation.
		const appTab = screen.getByRole('tab', { name: /app\.tsx/ });
		await userEvent.click(appTab);
		expect(onSelect).toHaveBeenCalledWith('/src/app.tsx');
	});

	it('calls onClose when close button is clicked', () => {
		const onClose = vi.fn();
		renderWithProviders(<FileTabs tabs={SAMPLE_TABS} activeTab="/src/main.ts" onSelect={vi.fn()} onClose={onClose} />);

		// Close buttons have aria-label="Close"
		const closeButtons = screen.getAllByLabelText('Close');
		fireEvent.click(closeButtons[0]);
		expect(onClose).toHaveBeenCalledWith('/src/main.ts');
	});

	it('shows file type icons', () => {
		renderWithProviders(<FileTabs tabs={SAMPLE_TABS} activeTab="/src/main.ts" onSelect={vi.fn()} onClose={vi.fn()} />);

		// Each tab should render a Lucide File icon (svg with lucide-file class)
		const fileIcons = document.querySelectorAll('.lucide-file');
		expect(fileIcons).toHaveLength(3);
	});
});
