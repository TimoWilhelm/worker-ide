/**
 * React component tests for the Landing Page.
 *
 * Mocks API calls and WebGL (jsdom has no WebGL support) to test
 * user interactions: template selection, detail modal, clone input,
 * recent projects, and back button handling.
 */

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import LandingPage from './landing-page';

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
				description: 'Inspect HTTP headers, geolocation, and connection info from a Cloudflare Worker.',
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

describe('LandingPage', () => {
	it('renders the page title', () => {
		render(<LandingPage />);

		expect(screen.getByText('Worker IDE')).toBeInTheDocument();
	});

	it('renders the halftone background', () => {
		render(<LandingPage />);

		expect(screen.getByTestId('halftone-background')).toBeInTheDocument();
	});

	it('renders template cards', async () => {
		render(<LandingPage />);

		expect(screen.getByText('Start a new project')).toBeInTheDocument();
		await waitFor(() => {
			expect(screen.getByText('Request Inspector')).toBeInTheDocument();
		});
	});

	it('renders a clone card in the template grid', async () => {
		render(<LandingPage />);

		await waitFor(() => {
			const cloneCard = screen.getByText('Clone a project').closest('button');
			expect(cloneCard).toBeTruthy();
		});
	});

	it('opens clone modal when clone card is clicked', async () => {
		render(<LandingPage />);

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
		render(<LandingPage />);

		expect(screen.getByLabelText(/Switch to light mode/i)).toBeInTheDocument();
	});

	// ---------------------------------------------------------------------------
	// Template detail modal
	// ---------------------------------------------------------------------------

	it('opens template detail modal when a card is clicked', async () => {
		render(<LandingPage />);

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
		expect(within(dialog).getByText(/Inspect HTTP headers/)).toBeInTheDocument();
		expect(within(dialog).getByRole('button', { name: 'Create Project' })).toBeInTheDocument();
	});

	it('creates a project when Create Project is clicked in the modal', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		mockedCreateProject.mockResolvedValueOnce({
			projectId: 'abc123',
			url: '/p/abc123',
			name: 'my-project',
		});

		render(<LandingPage />);

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
		render(<LandingPage />);

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
		render(<LandingPage />);

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

	it('enables clone button in modal when a valid 64-char hex ID is entered', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

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
		const validId = 'a'.repeat(64);
		await user.type(input, validId);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('enables clone button in modal when a full project URL is entered', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

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
		const validUrl = `https://example.dev/p/${'b'.repeat(64)}`;
		await user.type(input, validUrl);

		const cloneButton = within(dialog).getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('keeps clone button disabled for invalid input in modal', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

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

		render(<LandingPage />);

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
		const validId = 'c'.repeat(64);
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

		render(<LandingPage />);

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
		const validId = 'd'.repeat(64);
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
		render(<LandingPage />);

		expect(screen.queryByText('Recent projects')).not.toBeInTheDocument();
	});

	it('renders recent projects section with a single project', () => {
		vi.mocked(getRecentProjects).mockReturnValue([{ id: 'e'.repeat(64), timestamp: Date.now() - 3_600_000, name: 'My Project' }]);

		render(<LandingPage />);

		expect(screen.getByText('Recent projects')).toBeInTheDocument();
		expect(screen.getByText('My Project')).toBeInTheDocument();
	});

	it('renders all recent projects when multiple available', () => {
		vi.mocked(getRecentProjects).mockReturnValue([
			{ id: 'e'.repeat(64), timestamp: Date.now() - 3_600_000, name: 'My Project' },
			{ id: 'f'.repeat(64), timestamp: Date.now() - 86_400_000, name: 'Old Project' },
		]);

		render(<LandingPage />);

		expect(screen.getByText('Recent projects')).toBeInTheDocument();
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Old Project')).toBeInTheDocument();
	});

	it('recent project rows are links to the IDE app subdomain', () => {
		const projectId = 'a'.repeat(64);
		vi.mocked(getRecentProjects).mockReturnValue([{ id: projectId, timestamp: Date.now(), name: 'Test Project' }]);

		render(<LandingPage />);

		const link = screen.getByText('Test Project').closest('a');
		expect(link).toBeTruthy();
		// Links should point to the app subdomain
		const href = link?.getAttribute('href') ?? '';
		expect(href).toContain(`/p/${projectId}`);
		expect(href).toContain('app.');
	});
});
