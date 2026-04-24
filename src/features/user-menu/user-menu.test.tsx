import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { UserMenu } from './user-menu';

import type { ReactNode } from 'react';

const mockSetAppearanceModalOpen = vi.fn();

vi.mock('@/components/ui/dropdown-menu', () => ({
	DropdownMenu: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
	DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
	DropdownMenuItem: ({ children, onSelect, className }: { children: ReactNode; onSelect?: () => void; className?: string }) => (
		<button type="button" className={className} onClick={onSelect}>
			{children}
		</button>
	),
	DropdownMenuSeparator: () => <div />,
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: vi.fn(),
	},
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		useSession: () => ({
			data: {
				user: {
					name: 'Taylor Wilhelm',
					email: 'taylor@example.com',
					image: undefined,
				},
			},
		}),
		signOut: vi.fn(() => Promise.resolve()),
	},
}));

vi.mock('@/lib/store', () => ({
	selectOptimisticUserName: (state: { optimisticUserName?: string }) => state.optimisticUserName,
	useStore: (selector: (state: { optimisticUserName?: string; setAppearanceModalOpen: (open: boolean) => void }) => unknown) =>
		selector({
			optimisticUserName: undefined,
			setAppearanceModalOpen: mockSetAppearanceModalOpen,
		}),
}));

describe('UserMenu', () => {
	beforeEach(() => {
		mockSetAppearanceModalOpen.mockReset();
	});

	it('opens the appearance modal from the dropdown menu', async () => {
		const user = userEvent.setup();

		render(
			<MemoryRouter initialEntries={['/org/test-org']}>
				<UserMenu />
			</MemoryRouter>,
		);

		await user.click(screen.getByRole('button', { name: 'Appearance' }));

		expect(mockSetAppearanceModalOpen).toHaveBeenCalledWith(true);
	});
});
