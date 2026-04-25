import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { OrgSwitcher } from './org-switcher';

import type { ReactNode } from 'react';

const { mockSetActive } = vi.hoisted(() => ({
	mockSetActive: vi.fn(() => Promise.resolve()),
}));

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

vi.mock('@/components/ui/tooltip', () => ({
	Tooltip: ({ children }: { children: ReactNode }) => children,
}));

vi.mock('./create-org-modal', () => ({
	CreateOrgModal: () => <></>,
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: vi.fn(),
	},
}));

vi.mock('@/lib/api-client', () => ({
	fetchUserLimits: vi.fn(() => Promise.resolve({ maxFreeOrganizations: 3, currentFreeOrganizations: 1 })),
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		organization: {
			setActive: mockSetActive,
		},
	},
}));

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function Wrapper({ children, initialPath = '/org/acme/settings' }: { children: ReactNode; initialPath?: string }) {
	const [queryClient] = useState(createTestQueryClient);
	return (
		<MemoryRouter initialEntries={[initialPath]}>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
}

function LocationDisplay() {
	const location = useLocation();
	return <div data-testid="location-display">{location.pathname}</div>;
}

const organizations = [
	{ id: 'org-1', name: 'Acme', slug: 'acme' },
	{ id: 'org-2', name: 'Globex', slug: 'globex' },
];

describe('OrgSwitcher', () => {
	it('stays on organization settings when switching orgs with a custom destination', async () => {
		const user = userEvent.setup();

		render(
			<Wrapper>
				<Routes>
					<Route
						path="*"
						element={
							<>
								<OrgSwitcher
									organizations={organizations}
									currentOrganizationId="org-1"
									currentOrganizationName="Acme"
									getOrganizationPath={(organization) => `/org/${organization.slug}/settings`}
								/>
								<LocationDisplay />
							</>
						}
					/>
				</Routes>
			</Wrapper>,
		);

		await user.click(screen.getByRole('button', { name: 'Globex' }));

		await waitFor(() => {
			expect(mockSetActive).toHaveBeenCalledWith({ organizationId: 'org-2' });
		});
		await waitFor(() => {
			expect(screen.getByTestId('location-display')).toHaveTextContent('/org/globex/settings');
		});
	});

	it('navigates to manage organization from the dropdown action', async () => {
		const user = userEvent.setup();

		render(
			<Wrapper>
				<Routes>
					<Route
						path="*"
						element={
							<>
								<OrgSwitcher organizations={organizations} currentOrganizationId="org-1" currentOrganizationName="Acme" />
								<LocationDisplay />
							</>
						}
					/>
				</Routes>
			</Wrapper>,
		);

		await user.click(screen.getByRole('button', { name: 'Manage organization' }));

		await waitFor(() => {
			expect(screen.getByTestId('location-display')).toHaveTextContent('/org/acme/settings');
		});
	});
});
