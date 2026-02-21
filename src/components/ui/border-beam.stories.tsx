import { expect, within } from '@storybook/test';

import { BorderBeam } from './border-beam';

import type { Meta, StoryObj } from '@storybook/react';

const meta = {
	title: 'UI/BorderBeam',
	component: BorderBeam,
	parameters: {
		layout: 'centered',
	},
} satisfies Meta<typeof BorderBeam>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => (
		<div
			className="
				relative flex h-32 w-64 items-center justify-center rounded-lg border
				border-border bg-bg-secondary
			"
		>
			<BorderBeam />
			<span className="text-text-primary">Generating...</span>
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const text = await canvas.findByText('Generating...');
		await expect(text).toBeInTheDocument();
	},
};

export const Fast: Story = {
	render: () => (
		<div
			className="
				relative flex h-32 w-64 items-center justify-center rounded-lg border
				border-border bg-bg-secondary
			"
		>
			<BorderBeam duration={1} />
			<span className="text-text-primary">Fast Generation...</span>
		</div>
	),
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const text = await canvas.findByText('Fast Generation...');
		await expect(text).toBeInTheDocument();
	},
};
