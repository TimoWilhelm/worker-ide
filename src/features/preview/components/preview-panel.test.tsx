import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PreviewPanel } from './preview-panel';

import type { ReactNode } from 'react';

const mockStartPreviewElementPicker = vi.fn(() => true);
const mockCancelPreviewElementPicker = vi.fn(() => true);
const mockToggleDevtools = vi.fn();
const mockQueuePreviewElementReference = vi.fn();
const mockShowAgentPanel = vi.fn();

vi.mock('@/components/ui/loading-bars', () => ({
	LoadingBars: () => <div data-testid="loading-bars" />,
}));

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/features/preview/preview-iframe-reference', () => ({
	cancelPreviewElementPicker: () => mockCancelPreviewElementPicker(),
	startPreviewElementPicker: () => mockStartPreviewElementPicker(),
	previewIframeReference: { current: undefined },
	previewOriginReference: { current: undefined },
}));

vi.mock('@/lib/store', () => ({
	useStore: (selector: (state: Record<string, unknown>) => unknown) =>
		selector({
			devtoolsVisible: false,
			toggleDevtools: mockToggleDevtools,
			queuePreviewElementReference: mockQueuePreviewElementReference,
			showAgentPanel: mockShowAgentPanel,
		}),
}));

function renderPreviewPanel() {
	return render(
		<PreviewPanel
			previewUrl="https://example.com"
			previewOrigin="https://example.com"
			isLoadingUrl={false}
			refreshPreviewUrl={vi.fn(async () => {})}
			iframeReference={{ current: document.createElement('iframe') }}
		/>,
	);
}

describe('PreviewPanel', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('turns the picker off when the toggle button is clicked again', async () => {
		const user = userEvent.setup();
		renderPreviewPanel();

		const pickerButton = screen.getByRole('button', { name: 'Send to Agent' });

		await user.click(pickerButton);
		expect(mockStartPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).toContain('bg-accent/10');

		await user.click(pickerButton);
		expect(mockCancelPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).not.toContain('bg-accent/10');
	});

	it('turns the picker off when clicking outside the iframe', async () => {
		const user = userEvent.setup();
		renderPreviewPanel();

		const pickerButton = screen.getByRole('button', { name: 'Send to Agent' });

		await user.click(pickerButton);
		expect(pickerButton.className).toContain('bg-accent/10');

		fireEvent.pointerDown(document.body);
		expect(mockCancelPreviewElementPicker).toHaveBeenCalledOnce();
		expect(pickerButton.className).not.toContain('bg-accent/10');
	});
});
