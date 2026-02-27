import { expect, fn, userEvent, within } from 'storybook/test';

import { RecentProjectsDropdown } from './recent-projects-dropdown';

import type { Meta, StoryObj } from '@storybook/react-vite';

// Mock localStorage setup for stories
const mockLocalStorage = () => {
	const mockProjects = [
		{ id: 'proj-1', name: 'Alpha Project', timestamp: Date.now() - 1000 * 60 * 5 }, // 5 mins ago
		{ id: 'proj-2', name: 'Beta API', timestamp: Date.now() - 1000 * 60 * 60 * 2 }, // 2 hours ago
		{ id: 'proj-3', name: 'Legacy App', timestamp: Date.now() - 1000 * 60 * 60 * 24 * 3 }, // 3 days ago
	];
	localStorage.setItem('worker-ide-recent-projects', JSON.stringify(mockProjects));
};

const meta = {
	title: 'IDE/RecentProjectsDropdown',
	component: RecentProjectsDropdown,
	parameters: {
		layout: 'centered',
	},
	tags: ['autodocs'],
	args: {
		currentProjectId: 'proj-1',
		onNewProject: fn(),
	},
	decorators: [
		(Story) => {
			mockLocalStorage();
			return (
				<div className="flex rounded-md border border-border bg-bg-secondary p-4">
					<Story />
				</div>
			);
		},
	],
} satisfies Meta<typeof RecentProjectsDropdown>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Open dropdown', async () => {
			const trigger = await canvas.findByRole('button');
			await userEvent.click(trigger);
		});

		// The dropdown content is rendered in a portal, so we query the document body
		const body = within(document.body);

		await step('Verify current project formatting', async () => {
			// proj-1 is current, should have specific styling and "(current)" text
			const currentProj = await body.findByText(/Alpha Project/);
			await expect(currentProj).toBeInTheDocument();
			await expect(currentProj.textContent).toContain('(current)');
		});

		await step('Verify other projects exist', async () => {
			const betaProj = await body.findByText(/Beta API/);
			await expect(betaProj).toBeInTheDocument();
		});

		await step('Verify New Project option', async () => {
			const newProjButton = await body.findByText('New Project');
			await expect(newProjButton).toBeInTheDocument();
		});

		await step('Close dropdown', async () => {
			await userEvent.keyboard('{Escape}');
		});
	},
};

export const WithoutCurrentProject: Story = {
	args: {
		currentProjectId: 'unknown-id',
	},
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Open dropdown', async () => {
			const trigger = await canvas.findByRole('button');
			await userEvent.click(trigger);
		});

		const body = within(document.body);

		await step('Verify no project is marked current', async () => {
			const alphaProj = await body.findByText(/Alpha Project/);
			await expect(alphaProj.textContent).not.toContain('(current)');
		});
	},
};
