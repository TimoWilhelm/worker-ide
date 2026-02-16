/**
 * React component tests for the Landing Page.
 *
 * Mocks API calls and WebGL (jsdom has no WebGL support) to test
 * user interactions: template selection, clone input, recent projects.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
}));

// Mock recent-projects to return controlled data
vi.mock('@/lib/recent-projects', () => ({
	getRecentProjects: vi.fn(() => []),
	trackProject: vi.fn(),
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
	it('renders the page title and description', () => {
		render(<LandingPage />);

		expect(screen.getByText('Worker IDE')).toBeInTheDocument();
		expect(screen.getByText('Build and preview Cloudflare Workers in the browser')).toBeInTheDocument();
	});

	it('renders the halftone background', () => {
		render(<LandingPage />);

		expect(screen.getByTestId('halftone-background')).toBeInTheDocument();
	});

	it('renders template cards', () => {
		render(<LandingPage />);

		expect(screen.getByText('Start a new project')).toBeInTheDocument();
		expect(screen.getByText('Request Inspector')).toBeInTheDocument();
	});

	it('renders the clone section', () => {
		render(<LandingPage />);

		expect(screen.getByText('Clone a project')).toBeInTheDocument();
		expect(screen.getByPlaceholderText('Paste project URL or ID')).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Clone' })).toBeInTheDocument();
	});

	it('renders theme toggle button', () => {
		render(<LandingPage />);

		expect(screen.getByLabelText(/Switch to light mode/i)).toBeInTheDocument();
	});

	// ---------------------------------------------------------------------------
	// Template creation
	// ---------------------------------------------------------------------------

	it('creates a project when a template card is clicked', async () => {
		const mockedCreateProject = vi.mocked(createProject);
		mockedCreateProject.mockResolvedValueOnce({
			projectId: 'abc123',
			url: '/p/abc123',
			name: 'my-project',
		});

		render(<LandingPage />);

		const templateButton = screen.getByText('Request Inspector').closest('button');
		expect(templateButton).toBeTruthy();
		fireEvent.click(templateButton!);

		// Should show loading overlay
		expect(screen.getByText('Creating project...')).toBeInTheDocument();

		await waitFor(() => {
			expect(mockedCreateProject).toHaveBeenCalledWith('request-inspector');
		});
	});

	// ---------------------------------------------------------------------------
	// Clone input
	// ---------------------------------------------------------------------------

	it('disables clone button when input is empty', () => {
		render(<LandingPage />);

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('enables clone button when a valid 64-char hex ID is entered', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

		const input = screen.getByPlaceholderText('Paste project URL or ID');
		const validId = 'a'.repeat(64);
		await user.type(input, validId);

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('enables clone button when a full project URL is entered', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

		const input = screen.getByPlaceholderText('Paste project URL or ID');
		const validUrl = `https://example.dev/p/${'b'.repeat(64)}`;
		await user.type(input, validUrl);

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
		expect(cloneButton).not.toBeDisabled();
	});

	it('keeps clone button disabled for invalid input', async () => {
		const user = userEvent.setup();
		render(<LandingPage />);

		const input = screen.getByPlaceholderText('Paste project URL or ID');
		await user.type(input, 'not-a-valid-id');

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
		expect(cloneButton).toBeDisabled();
	});

	it('clones a project when clone button is clicked', async () => {
		const user = userEvent.setup();
		const mockedCloneProject = vi.mocked(cloneProject);
		mockedCloneProject.mockResolvedValueOnce({
			projectId: 'new123',
			url: '/p/new123',
			name: 'cloned-project',
		});

		render(<LandingPage />);

		const input = screen.getByPlaceholderText('Paste project URL or ID');
		const validId = 'c'.repeat(64);
		await user.type(input, validId);

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
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

		const input = screen.getByPlaceholderText('Paste project URL or ID');
		const validId = 'd'.repeat(64);
		await user.type(input, validId);

		const cloneButton = screen.getByRole('button', { name: 'Clone' });
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

	it('renders recent projects when available', () => {
		vi.mocked(getRecentProjects).mockReturnValue([
			{ id: 'e'.repeat(64), timestamp: Date.now() - 3_600_000, name: 'My Project' },
			{ id: 'f'.repeat(64), timestamp: Date.now() - 86_400_000, name: 'Old Project' },
		]);

		render(<LandingPage />);

		expect(screen.getByText('Recent projects')).toBeInTheDocument();
		expect(screen.getByText('My Project')).toBeInTheDocument();
		expect(screen.getByText('Old Project')).toBeInTheDocument();
	});

	it('recent project rows are links to the project', () => {
		const projectId = 'a'.repeat(64);
		vi.mocked(getRecentProjects).mockReturnValue([{ id: projectId, timestamp: Date.now(), name: 'Test Project' }]);

		render(<LandingPage />);

		const link = screen.getByText('Test Project').closest('a');
		expect(link).toBeTruthy();
		expect(link?.getAttribute('href')).toBe(`/p/${projectId}`);
	});
});
