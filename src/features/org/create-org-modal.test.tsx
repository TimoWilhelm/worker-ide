import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';

import { CreateOrgModal } from './create-org-modal';

const { mockCreateOrganization, mockSetActiveOrganization, mockRefetchOrganizations, mockRefetchActiveOrganization, mockToastSuccess } =
	vi.hoisted(() => ({
		mockCreateOrganization: vi.fn(),
		mockSetActiveOrganization: vi.fn(),
		mockRefetchOrganizations: vi.fn(),
		mockRefetchActiveOrganization: vi.fn(),
		mockToastSuccess: vi.fn(),
	}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: vi.fn(),
		success: mockToastSuccess,
	},
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		organization: {
			create: mockCreateOrganization,
			setActive: mockSetActiveOrganization,
		},
		useListOrganizations: () => ({ refetch: mockRefetchOrganizations }),
		useActiveOrganization: () => ({ refetch: mockRefetchActiveOrganization }),
	},
}));

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
		},
	});
}

describe('CreateOrgModal', () => {
	it('shows the maximum organizations message when the cap is reached', () => {
		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<MemoryRouter>
					<CreateOrgModal open onOpenChange={() => {}} freeOrganizationCount={1} maxFreeOrganizations={1} />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(screen.getByText('Maximum number of organizations reached.')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Create' })).toBeDisabled();
	});

	it('does not show the limit message when the user can still create an organization', () => {
		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<MemoryRouter>
					<CreateOrgModal open onOpenChange={() => {}} freeOrganizationCount={0} maxFreeOrganizations={1} />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(screen.queryByText('Maximum number of organizations reached.')).not.toBeInTheDocument();
	});

	it('closes the modal and shows success feedback after creating an organization', async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();

		mockCreateOrganization.mockResolvedValue({
			data: {
				id: 'org-123',
				slug: '11111111-1111-4111-8111-111111111111',
			},
		});
		mockSetActiveOrganization.mockImplementation(() => Promise.resolve());
		mockRefetchOrganizations.mockImplementation(() => Promise.resolve());
		mockRefetchActiveOrganization.mockImplementation(() => Promise.resolve());
		vi.stubGlobal('crypto', { randomUUID: () => '11111111-1111-4111-8111-111111111111' });

		render(
			<QueryClientProvider client={createTestQueryClient()}>
				<MemoryRouter>
					<CreateOrgModal open onOpenChange={onOpenChange} freeOrganizationCount={0} maxFreeOrganizations={1} />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		await user.type(screen.getByRole('textbox'), 'My Team');
		await user.click(screen.getByRole('button', { name: 'Create' }));

		await waitFor(() => {
			expect(mockCreateOrganization).toHaveBeenCalled();
			expect(mockSetActiveOrganization).toHaveBeenCalledWith({ organizationId: 'org-123' });
			expect(onOpenChange).toHaveBeenCalledWith(false);
			expect(mockToastSuccess).toHaveBeenCalledWith('Organization created');
		});
	});
});
