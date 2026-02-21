import { expect, within } from '@storybook/test';

import { Pill } from './pill';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'UI/Pill',
	component: Pill,
	parameters: {
		layout: 'centered',
	},
	tags: ['autodocs'],
	argTypes: {
		color: {
			control: 'select',
			options: ['muted', 'success', 'warning', 'error', 'red', 'yellow', 'cyan', 'emerald', 'amber', 'sky'],
		},
		size: {
			control: 'select',
			options: ['xs', 'sm', 'md'],
		},
		rounded: {
			control: 'select',
			options: ['full', 'sm'],
		},
	},
} satisfies Meta<typeof Pill>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		children: 'Muted',
		color: 'muted',
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const pill = await canvas.findByText('Muted');
		await expect(pill).toBeInTheDocument();
	},
};

export const Success: Story = {
	args: {
		children: 'Success',
		color: 'success',
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const pill = await canvas.findByText('Success');
		await expect(pill).toBeInTheDocument();
	},
};

export const Error: Story = {
	args: {
		children: 'Error',
		color: 'error',
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const pill = await canvas.findByText('Error');
		await expect(pill).toBeInTheDocument();
	},
};

export const Warning: Story = {
	args: {
		children: 'Warning',
		color: 'warning',
	},
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const pill = await canvas.findByText('Warning');
		await expect(pill).toBeInTheDocument();
	},
};

export const Colors: Story = {
	render: () => (
		<div className="flex gap-2">
			<Pill color="cyan">Cyan</Pill>
			<Pill color="emerald">Emerald</Pill>
			<Pill color="sky">Sky</Pill>
			<Pill color="purple">Purple</Pill>
			<Pill color="red">Red</Pill>
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await expect(await canvas.findByText('Cyan')).toBeInTheDocument();
		await expect(await canvas.findByText('Emerald')).toBeInTheDocument();
		await expect(await canvas.findByText('Sky')).toBeInTheDocument();
		await expect(await canvas.findByText('Purple')).toBeInTheDocument();
		await expect(await canvas.findByText('Red')).toBeInTheDocument();
	},
};
