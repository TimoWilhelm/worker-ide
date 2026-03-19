/**
 * React component tests for the Dashboard Page.
 *
 * Mocks API calls and WebGL (jsdom has no WebGL support) to test
 * user interactions: template selection, detail modal, clone input,
 * recent projects, and back button handling.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import DashboardPage from './dashboard-page';

// =============================================================================
// Mocks
// =============================================================================

// Mock the API client
vi.mock('@/lib/api-client', () => ({
	createProject: vi.fn(),
	cloneProject: vi.fn(),
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
}));

// Mock recent-projects to return controlled data
vi.mock('@/lib/recent-projects', () => ({
	getRecentProjects: vi.fn(() => []),
	trackProject: vi.fn(),
	removeProject: vi.fn(),
}));

// Mock the store (for theme toggle)
const mockSetColorScheme = vi.fn();
vi.mock('@/lib/store', () => ({
	useStore: (selector: (state: Record<string, unknown>) => unknown) => {
		const state = { setColorScheme: mockSetColorScheme };
		return selector(state);
	},
}));

// Mock the theme hook
vi.mock('@/hooks/use-theme', () => ({
	useTheme: () => 'dark',
}));

// Mock the HalftoneBackground — WebGL is not available in jsdom
vi.mock('./halftone-background', () => ({
	HalftoneBackground: () => <canvas data-testid="halftone-background" />,
}));

// Prevent navigation during tests
const originalLocation = globalThis.location;

beforeEach(() => {
	// Stub location.href setter to capture navigation
	Object.defineProperty(globalThis, 'location', {
		writable: true,
		value: { ...originalLocation, href: '' },
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	globalThis.location = originalLocation;
});

// =============================================================================
// Import mocked modules (after vi.mock declarations)
// =============================================================================

const { createProject, cloneProject } = await import('@/lib/api-client');
const { getRecentProjects } = await import('@/lib/recent-projects');

// =============================================================================
// Tests
// =============================================================================

describe('DashboardPage', () => {
	it('renders the page title', () => {
		render(<DashboardPage />);

		expect(screen.getByText('Codemaxxing')).toBeInTheDocument();
	});

	it('renders the halftone background', () => {
		render(<DashboardPage />);

		expect(screen.getByTestId('halftone-background')).toBeInTheDocument();
	});

	it('renders template cards', async () => {
		render(<DashboardPage />);

		expect(screen.getByText('Start a new project')).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('Request Inspector')).toBeInTheDocument();
		});
	});

	it('renders a clone card in the template grid', async () => {
		render(<DashboardPage />);

		await waitFor(() => {
			const cloneCard = screen.getByText('Clone a project').closest('button');
			expect(cloneCard).toBeTruthy();
		});
	});

	it('opens clone modal when clone card is clicked', async () => {
		render(<DashboardPage />);

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

	it('renders theme toggle button', () => {
		render(<DashboardPage />);

		expect(screen.getByLabelText(/Switch to light mode/i)).toBeInTheDocument();
	});

	// ---------------------------------------------------------------------------
	// Template detail modal
	// ---------------------------------------------------------------------------

	it('opens template detail modal when a card is clicked', async () => {
		render(<DashboardPage />);

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

		render(<DashboardPage />);

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
			expect(mockedCreateProject).toHaveBeenCalledWith('request-inspector');
		});
	});

	it('closes the modal when Cancel is clicked', async () => {
		render(<DashboardPage />);

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
		render(<DashboardPage />);

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
		render(<DashboardPage />);

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
		render(<DashboardPage />);

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
		render(<DashboardPage />);

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

		render(<DashboardPage />);

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
			expect(mockedCloneProject).toHaveBeenCalledWith(validId);
		});
	});

	it('shows clone error message on failure', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockRejectedValueOnce(new Error('Source project not found or not initialized'));

		render(<DashboardPage />);

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

	it('does not render recent projects section when empty', () => {
		render(<DashboardPage />);

		expect(screen.queryByText('Recent projects')).not.toBeInTheDocument();
	});

	it('renders recent projects section with a single project', () => {
		vi.mocked(getRecentProjects).mockReturnValue([
			{ id: '5ydvqzhiqckl5fa63nhky2pstb212hcdj0lk19eklkmc7snawe', timestamp: Date.now() - 3_600_000, name: 'My Project' },
		]);

		render(<DashboardPage />);

		expect(screen.getByText('Recent projects')).toBeInTheDocument();
		expect(screen.getByText('My Project')).toBeInTheDocument();
	});

	it('renders all recent projects when multiple available', () => {
		vi.mocked(getRecentProjects).mockReturnValue([
			{ id: '5ydvqzhiqckl5fa63nhky2pstb212hcdj0lk19eklkmc7snawe', timestamp: Date.now() - 3_600_000, name: 'My Project' },
			{ id: '6dp5qcb22im238nr3wvp0ic7q99w035jmy2iw7i6n43d37jtof', timestamp: Date.now() - 86_400_000, name: 'Old Project' },
		]);

		render(<DashboardPage />);

		expect(screen.getByText('Recent projects')).toBeInTheDocument();
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Old Project')).toBeInTheDocument();
	});

	it('recent project rows are links to the project page', () => {
		const projectId = '494rtk7ddoepe5ru2lx4oc855i6lc23p3apolh04feq8q517sa';
		vi.mocked(getRecentProjects).mockReturnValue([{ id: projectId, timestamp: Date.now(), name: 'Test Project' }]);

		render(<DashboardPage />);

		const link = screen.getByText('Test Project').closest('a');
		expect(link).toBeTruthy();
		expect(link?.getAttribute('href')).toBe(`/p/${projectId}`);
	});
});
