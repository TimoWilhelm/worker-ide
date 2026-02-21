import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { Tooltip } from './tooltip';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Tooltip',
	component: Tooltip,
	parameters: {
		layout: 'centered',
	},
	args: {
		children: undefined,
		content: '',
	},
	decorators: [
		(Story) => (
			<div className="p-10">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<Tooltip content="Add to library" side="top" delayDuration={0}>
			<Button variant="outline">Hover</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Hover/i });
		await userEvent.hover(button);

		const body = within(document.body);
		const tooltipContent = await body.findByRole('tooltip');
		await expect(tooltipContent).toHaveTextContent('Add to library');
	},
};

export const Right: Story = {
	render: () => (
		<Tooltip content="Configuration" side="right" delayDuration={0}>
			<Button variant="outline">Settings</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Settings/i });
		await userEvent.hover(button);

		const body = within(document.body);
		const tooltipContent = await body.findByRole('tooltip');
		await expect(tooltipContent).toHaveTextContent('Configuration');
	},
};

export const Bottom: Story = {
	render: () => (
		<Tooltip content="Save changes" side="bottom" delayDuration={0}>
			<Button variant="outline">Save</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Save/i });
		await userEvent.hover(button);

		const body = within(document.body);
		const tooltipContent = await body.findByRole('tooltip');
		await expect(tooltipContent).toHaveTextContent('Save changes');
	},
};

export const Left: Story = {
	render: () => (
		<Tooltip content="Undo last action" side="left" delayDuration={0}>
			<Button variant="outline">Undo</Button>
		</Tooltip>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Undo/i });
		await userEvent.hover(button);

		const body = within(document.body);
		const tooltipContent = await body.findByRole('tooltip');
		await expect(tooltipContent).toHaveTextContent('Undo last action');
	},
};
