import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import AccountPage from './account-page';

const mocks = vi.hoisted(() => ({
	listSessions: vi.fn(),
	revokeSession: vi.fn(),
	revokeSessions: vi.fn(),
	useSession: vi.fn(),
	deleteAccount: vi.fn(),
	fetchAccountDeletePreview: vi.fn(),
	toastError: vi.fn(),
	toastSuccess: vi.fn(),
}));

vi.mock('@/lib/auth-client', () => ({
	authClient: {
		listSessions: mocks.listSessions,
		revokeSession: mocks.revokeSession,
		revokeSessions: mocks.revokeSessions,
		useSession: mocks.useSession,
	},
}));

vi.mock('@/lib/api-client', () => ({
	deleteAccount: mocks.deleteAccount,
	fetchAccountDeletePreview: mocks.fetchAccountDeletePreview,
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: mocks.toastError,
		success: mocks.toastSuccess,
	},
}));

function renderAccountPage() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: {
				retry: false,
			},
		},
	});

	return render(
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>
				<AccountPage />
			</QueryClientProvider>
		</MemoryRouter>,
	);
}

describe('AccountPage', () => {
	beforeEach(() => {
		mocks.useSession.mockReturnValue({
			data: {
				user: {
					email: 'taylor@example.com',
				},
			},
		});
		mocks.listSessions.mockResolvedValue({
			data: [
				{
					token: 'current-session',
					userAgent: 'Desktop Chrome',
					ipAddress: '127.0.0.1',
					createdAt: '2026-04-20T12:00:00.000Z',
					current: true,
				},
				{
					token: 'other-session',
					userAgent: 'iPhone Mobile Safari',
					ipAddress: '127.0.0.2',
					createdAt: '2026-04-18T12:00:00.000Z',
					current: false,
				},
			],
			error: undefined,
		});
		mocks.revokeSession.mockResolvedValue({ error: undefined });
		mocks.revokeSessions.mockResolvedValue({ error: undefined });
		mocks.toastError.mockReset();
		mocks.toastSuccess.mockReset();
	});

	it('confirms before revoking an individual session', async () => {
		const user = userEvent.setup();
		renderAccountPage();

		await screen.findByRole('button', { name: 'Revoke' });
		await user.click(screen.getByRole('button', { name: 'Revoke' }));

		const revokeDialog = await screen.findByRole('dialog', { name: 'Revoke this session?' });

		await user.click(within(revokeDialog).getByRole('button', { name: 'Revoke' }));

		await waitFor(() => expect(mocks.revokeSession).toHaveBeenCalledWith({ token: 'other-session' }));
	});

	it('confirms before signing out all other sessions', async () => {
		const user = userEvent.setup();
		renderAccountPage();

		await screen.findByRole('button', { name: 'Sign out all others' });
		await user.click(screen.getByRole('button', { name: 'Sign out all others' }));

		const signOutDialog = await screen.findByRole('dialog', { name: 'Sign out all sessions?' });

		await user.click(within(signOutDialog).getByRole('button', { name: 'Sign out' }));

		await waitFor(() => expect(mocks.revokeSessions).toHaveBeenCalledTimes(1));
	});
});
