import { expect, fn, userEvent, within } from 'storybook/test';

import { IDEHeader } from './ide-header';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'IDE/IDEHeader',
	component: IDEHeader,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectId: 'test-project-123',
		projectNameState: {
			projectName: 'Test Project',
			isEditingName: false,
			editNameValue: 'Test Project',
			setEditNameValue: fn(),
			nameInputReference: { current: document.createElement('input') },
			handleStartRename: fn(),
			handleSaveRename: fn(),
			handleCancelRename: fn(),
		},
		resolvedTheme: 'dark',
		setColorScheme: fn(),
		isMobile: false,
		isSaving: false,
		aiPanelVisible: false,
		toggleAIPanel: fn(),
		isAiProcessing: false,
		mobileMenuOpen: false,
		setMobileMenuOpen: fn(),
		onDownload: fn(),
		onNewProject: fn(),
	},
} satisfies Meta<typeof IDEHeader>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DesktopView: Story = {
	play: async ({ canvasElement, step, args }) => {
		const canvas = within(canvasElement);

		await step('Verify project name is displayed', async () => {
			const header = await canvas.findByRole('heading', { level: 1 });
			await expect(header).toHaveTextContent('Test Project');
		});

		await step('Verify desktop action buttons exist', async () => {
			// Should have toggles for AI, Theme, and Download + Home, Rename, Recent Projects
			// We can check by aria-labels
			await expect(await canvas.findByLabelText('Toggle Agent panel')).toBeInTheDocument();
			await expect(await canvas.findByLabelText('Toggle color theme')).toBeInTheDocument();
			await expect(await canvas.findByLabelText('Download project')).toBeInTheDocument();
		});

		await step('Interact with AI Toggle', async () => {
			const aiToggle = await canvas.findByLabelText('Toggle Agent panel');
			await userEvent.click(aiToggle);
			await expect(args.toggleAIPanel).toHaveBeenCalled();
		});
	},
};

export const MobileView: Story = {
	args: {
		isMobile: true,
	},
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);

		await step('Verify AI toggle is hidden on mobile', async () => {
			const aiToggle = canvas.queryByLabelText('Toggle Agent panel');
			await expect(aiToggle).not.toBeInTheDocument();
		});

		await step('Verify More menu exists on mobile', async () => {
			const moreMenu = await canvas.findByLabelText('More options');
			await expect(moreMenu).toBeInTheDocument();
		});
	},
};

export const SavingState: Story = {
	args: {
		isSaving: true,
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Saving...')).toBeInTheDocument();
	},
};

export const EditingName: Story = {
	args: {
		projectNameState: {
			projectName: 'Test Project',
			isEditingName: true,
			editNameValue: 'New Name Edited',
			setEditNameValue: fn(),
			nameInputReference: { current: document.createElement('input') },
			handleStartRename: fn(),
			handleSaveRename: fn(),
			handleCancelRename: fn(),
		},
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const input = await canvas.findByDisplayValue('New Name Edited');
		await expect(input).toBeInTheDocument();
	},
};

export const LightTheme: Story = {
	args: {
		resolvedTheme: 'light',
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const themeToggle = await canvas.findByLabelText('Toggle color theme');
		await expect(themeToggle).toBeInTheDocument();
	},
};
