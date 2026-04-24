import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from './dashboard-page';

vi.mock('@/components/beta-indicator', () => ({
	BetaIndicator: () => <span data-testid="beta-indicator">&beta;</span>,
}));

// Mock the API client
vi.mock('@/lib/api-client', () => ({
	createProject: vi.fn(),
	cloneProject: vi.fn(),
	deleteProject: vi.fn(() => Promise.resolve()),
	fetchTemplates: vi.fn(() =>
		Promise.resolve([
			{
				id: 'request-inspector',
				name: 'Request Inspector',
				description: 'Inspect incoming HTTP request headers, geolocation, and connection info.',
				icon: 'Search',
			},
		]),
	),
	fetchOrgProjects: vi.fn(() => Promise.resolve([])),
	fetchUserLimits: vi.fn(() => Promise.resolve({ maxFreeOrganizations: 3, currentFreeOrganizations: 1 })),
}));

// Mock org switcher
vi.mock('@/features/org/org-switcher', () => ({
	OrgSwitcher: () => <div data-testid="org-switcher" />,
}));

// Mock user menu
vi.mock('@/features/user-menu', () => ({
	UserMenu: () => <div data-testid="user-menu" />,
}));

// Mock the HalftoneBackground — WebGL is not available in jsdom
vi.mock('@/components/halftone-background', () => ({
	HalftoneBackground: () => <canvas data-testid="halftone-background" />,
}));

function createTestQueryClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
}

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const [queryClient] = useState(createTestQueryClient);
	return (
		<MemoryRouter>
			<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
		</MemoryRouter>
	);
}

function renderWithQuery(ui: React.ReactElement) {
	return render(ui, { wrapper: QueryWrapper });
}

afterEach(() => {
	vi.restoreAllMocks();
});

const { createProject, cloneProject, deleteProject, fetchOrgProjects } = await import('@/lib/api-client');

type DashboardProject = Awaited<ReturnType<typeof fetchOrgProjects>>[number];

function makeProject(overrides: Partial<DashboardProject> = {}): DashboardProject {
	const timestamp = new Date().toISOString();

	/* eslint-disable unicorn/no-null -- Hono RPC infers nullable timestamps from Drizzle columns */
	return {
		id: '5ydvqzhiqckl5fa63nhky2pstb212hcdj0lk19eklkmc7snawe',
		organizationId: 'org1',
		durableObjectHexId: 'abc123',
		name: 'My Project',
		previewVisibility: 'public',
		createdAt: timestamp,
		updatedAt: timestamp,
		deletedAt: null,
		bannedAt: null,
		lastActivityAt: timestamp,
		...overrides,
	};
	/* eslint-enable unicorn/no-null */
}

const defaultProperties = {
	orgSlug: 'test-org',
	organizationId: 'org1',
	organizations: [{ id: 'org1', name: 'Test Org', slug: 'test-org' }],
	user: { name: 'Test User', email: 'test@example.com' },
};

describe('DashboardPage', () => {
	it('renders the page title', () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.getByText('Codemaxxing')).toBeInTheDocument();
	});

	it('renders the halftone background', () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.getByTestId('halftone-background')).toBeInTheDocument();
	});

	it('renders template cards', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.getByText('Start a new project')).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('Request Inspector')).toBeInTheDocument();
		});
	});

	it('renders a clone card in the template grid', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			const cloneCard = screen.getByText('Clone a project').closest('button');
			expect(cloneCard).toBeTruthy();
		});
	});

	it('opens clone modal when clone card is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});

		const cloneCard = screen.getByText('Clone a project').closest('button')!;
		fireEvent.click(cloneCard);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByPlaceholderText('Project URL or ID')).toBeInTheDocument();
	});

	it('renders user menu', () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.getByTestId('user-menu')).toBeInTheDocument();
	});

	// ---------------------------------------------------------------------------
	// Template detail modal
	// ---------------------------------------------------------------------------

	it('opens template detail modal when a card is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Wait for templates to load
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		// Modal should be open with template details
		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText('Request Inspector')).toBeInTheDocument();
		expect(within(dialog).getByText(/Inspect incoming HTTP request headers/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create Project' })).toBeInTheDocument();
	});

	it('creates a project when Create Project is clicked in the modal', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		mockedCreateProject.mockResolvedValueOnce({
			projectId: 'abc123',
			url: '/p/abc123',
			name: 'my-project',
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		// Click "Create Project" in the modal
		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
		const createButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Project' });
		fireEvent.click(createButton);

		// Should show loading overlay
		expect(screen.getByText('Creating project...')).toBeInTheDocument();

		await waitFor(() => {
			expect(mockedCreateProject).toHaveBeenCalledWith('org1', 'request-inspector');
		});
	});

	it('closes the modal when Cancel is clicked', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		// Click Cancel
		const cancelButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' });
		fireEvent.click(cancelButton);

		await waitFor(() => {
			expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
		});
	});

	// ---------------------------------------------------------------------------
	// Clone input
	// ---------------------------------------------------------------------------

	it('disables clone button in modal when input is empty', async () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('enables clone button in modal when a valid project ID is entered', async () => {
		const user = userEvent.setup();
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('enables clone button in modal when a full project URL is entered', async () => {
		const user = userEvent.setup();
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validUrl = `https://example.dev/p/${'4og1sx0wpug6bz5f2vb8qruk2geg9nwv786ngf3qgy79ljxqkb'}`;
		await user.type(input, validUrl);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('keeps clone button disabled for invalid input in modal', async () => {
		const user = userEvent.setup();
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		await user.type(input, 'not-a-valid-id');

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('clones a project when clone button is clicked in modal', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockResolvedValueOnce({
			projectId: 'new123',
			url: '/p/new123',
			name: 'cloned-project',
		});

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '53rbs9ug20hn9sj034pct7gyzemb79q1b5nmbd7cihoagyu9cc';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		fireEvent.click(cloneButton);

		expect(screen.getByText('Cloning project...')).toBeInTheDocument();

		await waitFor(() => {
			expect(mockedCloneProject).toHaveBeenCalledWith('org1', validId);
		});
	});

	it('shows clone error message on failure', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockRejectedValueOnce(new Error('Source project not found or not initialized'));

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open clone modal
		await waitFor(() => {
			expect(screen.getByText('Clone a project').closest('button')).toBeTruthy();
		});
		fireEvent.click(screen.getByText('Clone a project').closest('button')!);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		const input = within(dialog).getByPlaceholderText('Project URL or ID');
		const validId = '5j2lrmnze6j47lwl3e3gvn3dwcu64vj7f34l6bayk15bcdqs4d';
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		fireEvent.click(cloneButton);

		await waitFor(() => {
			expect(screen.getByText('Source project not found or not initialized')).toBeInTheDocument();
		});
	});

	// ---------------------------------------------------------------------------
	// Recent projects
	// ---------------------------------------------------------------------------

	it('does not render projects section when empty', () => {
		renderWithQuery(<DashboardPage {...defaultProperties} />);

		expect(screen.queryByText('Your projects')).not.toBeInTheDocument();
	});

	it('renders projects section with a single project', async () => {
		vi.mocked(fetchOrgProjects).mockResolvedValue([
			makeProject({
				createdAt: new Date(Date.now() - 3_600_000).toISOString(),
				updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
			}),
		]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Your projects')).toBeInTheDocument();
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
	});

	it('renders all projects when multiple available', async () => {
		vi.mocked(fetchOrgProjects).mockResolvedValue([
			makeProject({
				createdAt: new Date(Date.now() - 3_600_000).toISOString(),
				updatedAt: new Date(Date.now() - 3_600_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 3_600_000).toISOString(),
			}),
			makeProject({
				id: '6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof',
				durableObjectHexId: 'def456',
				name: 'Old Project',
				createdAt: new Date(Date.now() - 86_400_000).toISOString(),
				updatedAt: new Date(Date.now() - 86_400_000).toISOString(),
				lastActivityAt: new Date(Date.now() - 86_400_000).toISOString(),
			}),
		]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Your projects')).toBeInTheDocument();
		});
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Old Project')).toBeInTheDocument();
	});

	it('opens delete confirmation modal and deletes a project', async () => {
		const user = userEvent.setup();
		vi.mocked(fetchOrgProjects).mockResolvedValue([makeProject({ name: 'Doomed Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Doomed Project')).toBeInTheDocument();
		});

		// Click the delete button (visible on hover, but rendered in DOM)
		const deleteButton = screen.getByLabelText('Delete Doomed Project');
		await user.click(deleteButton);

		// Confirmation modal should appear
		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});

		const dialog = screen.getByRole('dialog');
		expect(within(dialog).getByText(/Are you sure you want to delete/)).toBeInTheDocument();
		expect(within(dialog).getByText('Doomed Project')).toBeInTheDocument();
		expect(within(dialog).getByText(/cannot be undone/)).toBeInTheDocument();

		// Delete button should be disabled until confirmation text is typed
		const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
		expect(confirmButton).toBeDisabled();

		// Type 'DELETE' to unlock the button
		const confirmInput = within(dialog).getByRole('textbox');
		await user.type(confirmInput, 'DELETE');
		expect(confirmButton).toBeEnabled();

		await user.click(confirmButton);

		await waitFor(() => {
			expect(vi.mocked(deleteProject)).toHaveBeenCalledWith('org1', '5ydvqzhiqckl5fa63nhky2pstb212hcdj0lk19eklkmc7snawe');
		});
	});

	it('clears loading overlay when page is restored from bfcache (browser back)', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		// Never resolves — simulates the navigation happening before promise settles
		mockedCreateProject.mockReturnValueOnce(new Promise(() => {}));

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		// Open the detail modal
		const templateButton = await waitFor(() => {
			const button = screen.getByText('Request Inspector').closest('button');
			expect(button).toBeTruthy();
			return button!;
		});
		fireEvent.click(templateButton);

		await waitFor(() => {
			expect(screen.getByRole('dialog')).toBeInTheDocument();
		});
		const createButton = within(screen.getByRole('dialog')).getByRole('button', { name: 'Create Project' });
		fireEvent.click(createButton);

		// Loading overlay should be visible
		expect(screen.getByText('Creating project...')).toBeInTheDocument();

		// Simulate bfcache restore (browser back button)
		globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		// Loading overlay should be cleared
		await waitFor(() => {
			expect(screen.queryByText('Creating project...')).not.toBeInTheDocument();
		});
	});

	it('refreshes the project list when page is restored from bfcache', async () => {
		const mockedFetchOrgProjects = vi.mocked(fetchOrgProjects);
		mockedFetchOrgProjects
			.mockResolvedValueOnce([makeProject({ name: 'Old Project Name' })])
			.mockResolvedValueOnce([makeProject({ name: 'Renamed Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Old Project Name')).toBeInTheDocument();
		});

		globalThis.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));

		await waitFor(() => {
			expect(screen.getByText('Renamed Project')).toBeInTheDocument();
		});
		expect(screen.queryByText('Old Project Name')).not.toBeInTheDocument();
	});

	it('project rows are links to the project page', async () => {
		const projectId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		vi.mocked(fetchOrgProjects).mockResolvedValue([makeProject({ id: projectId, name: 'Test Project' })]);

		renderWithQuery(<DashboardPage {...defaultProperties} />);

		await waitFor(() => {
			expect(screen.getByText('Test Project')).toBeInTheDocument();
		});

		const link = screen.getByText('Test Project').closest('a');
		expect(link).toBeTruthy();
		expect(link?.getAttribute('href')).toBe(`/p/${projectId}`);
	});
});
