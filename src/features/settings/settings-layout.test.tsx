import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import SettingsLayout from './settings-layout';

import type { ReactNode } from 'react';

vi.mock('@/components/beta-indicator', () => ({
	BetaIndicator: () => <span>Beta</span>,
}));

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('@/features/user-menu', () => ({
	UserMenu: () => <div>User menu</div>,
}));

vi.mock('./settings-mobile-drawer', () => ({
	SettingsMobileDrawer: () => <></>,
}));

function SettingsLayoutHarness() {
	const location = useLocation();

	return (
		<SettingsLayout activePath={location.pathname}>
			<div>Settings content</div>
		</SettingsLayout>
	);
}

describe('SettingsLayout', () => {
	it('preserves the original back target across settings navigation', () => {
		render(
			<MemoryRouter initialEntries={[{ pathname: '/settings/profile', state: { from: '/org/acme' } }]}>
				<Routes>
					<Route path="/settings/*" element={<SettingsLayoutHarness />} />
					<Route path="/org/:orgSlug" element={<div>Organization page</div>} />
					<Route path="/" element={<div>Home page</div>} />
				</Routes>
			</MemoryRouter>,
		);

		fireEvent.click(screen.getByRole('link', { name: 'Account' }));
		fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

		expect(screen.getByText('Organization page')).toBeInTheDocument();
	});

	it('falls back to home when no back target is available', () => {
		render(
			<MemoryRouter initialEntries={['/settings/profile']}>
				<Routes>
					<Route path="/settings/*" element={<SettingsLayoutHarness />} />
					<Route path="/" element={<div>Home page</div>} />
				</Routes>
			</MemoryRouter>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Go back' }));

		expect(screen.getByText('Home page')).toBeInTheDocument();
	});
});
