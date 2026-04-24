import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_EDITOR_FONT } from '@shared/constants';

import { AppearanceModal } from './appearance-modal';

const mockSetAppearanceModalOpen = vi.fn();
const mockSetColorScheme = vi.fn();
const mockSetEditorFont = vi.fn();

vi.mock('@/hooks/use-theme', () => ({
	useTheme: () => 'dark',
}));

vi.mock('@/lib/store', () => ({
	useStore: (
		selector: (state: {
			isAppearanceModalOpen: boolean;
			setAppearanceModalOpen: (open: boolean) => void;
			colorScheme: 'light' | 'dark' | 'system';
			setColorScheme: (scheme: 'light' | 'dark' | 'system') => void;
			editorFont: string;
			setEditorFont: (font: string) => void;
		}) => unknown,
	) =>
		selector({
			isAppearanceModalOpen: true,
			setAppearanceModalOpen: mockSetAppearanceModalOpen,
			colorScheme: 'dark',
			setColorScheme: mockSetColorScheme,
			editorFont: DEFAULT_EDITOR_FONT,
			setEditorFont: mockSetEditorFont,
		}),
}));

describe('AppearanceModal', () => {
	beforeEach(() => {
		mockSetAppearanceModalOpen.mockReset();
		mockSetColorScheme.mockReset();
		mockSetEditorFont.mockReset();
	});

	it('renders the appearance controls when open', () => {
		render(<AppearanceModal />);

		expect(screen.getByText('Appearance')).toBeInTheDocument();
		expect(screen.getByText('Theme')).toBeInTheDocument();
		expect(screen.getByText('Editor Font')).toBeInTheDocument();
	});

	it('updates preferences from the modal controls', async () => {
		const user = userEvent.setup();

		render(<AppearanceModal />);

		await user.click(screen.getByRole('button', { name: 'Light' }));
		await user.click(screen.getByRole('button', { name: /JetBrains Mono/i }));

		expect(mockSetColorScheme).toHaveBeenCalledWith('light');
		expect(mockSetEditorFont).toHaveBeenCalled();
	});
});
