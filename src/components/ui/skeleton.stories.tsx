import { expect, within } from '@storybook/test';

import { Skeleton, EditorSkeleton, FileTreeSkeleton, GitPanelSkeleton, PanelSkeleton } from './skeleton';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'UI/Skeleton',
	component: Skeleton,
	parameters: {
		layout: 'padded',
	},
} satisfies Meta<typeof Skeleton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<div className="flex items-center space-x-4">
			<Skeleton data-testid="skeleton-circle" className="size-12 rounded-full" />
			<div className="space-y-2">
				<Skeleton data-testid="skeleton-line-1" className="h-4 w-62.5" />
				<Skeleton data-testid="skeleton-line-2" className="h-4 w-utility-panel" />
			</div>
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId('skeleton-circle')).toBeInTheDocument();
		await expect(canvas.getByTestId('skeleton-line-1')).toBeInTheDocument();
	},
};

export const FileTree: Story = {
	render: () => (
		<div data-testid="file-tree-skeleton" className="h-96 w-64 border border-border bg-bg-secondary">
			<FileTreeSkeleton />
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId('file-tree-skeleton')).toBeInTheDocument();
	},
};

export const Editor: Story = {
	render: () => (
		<div data-testid="editor-skeleton" className="h-64 w-96 border border-border bg-bg-secondary">
			<EditorSkeleton />
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId('editor-skeleton')).toBeInTheDocument();
	},
};

export const Panel: Story = {
	render: () => (
		<div data-testid="panel-skeleton" className="h-64 w-64 border border-border bg-bg-secondary">
			<PanelSkeleton label="Terminal" />
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId('panel-skeleton')).toBeInTheDocument();
		await expect(canvas.getByText('Terminal')).toBeInTheDocument();
	},
};

export const GitPanel: Story = {
	render: () => (
		<div data-testid="git-panel-skeleton" className="h-64 w-64 border border-border bg-bg-secondary">
			<GitPanelSkeleton />
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(canvas.getByTestId('git-panel-skeleton')).toBeInTheDocument();
	},
};
