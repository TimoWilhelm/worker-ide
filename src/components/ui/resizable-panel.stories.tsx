import { ResizablePanel } from './resizable-panel';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/ResizablePanel',
	component: ResizablePanel,
	argTypes: {
		direction: {
			control: 'select',
			options: ['horizontal', 'vertical'],
		},
		handlePosition: {
			control: 'select',
			options: ['start', 'end'],
		},
	},
	decorators: [
		(Story) => (
			<div className="h-[400px] w-full border border-border">
				<Story />
			</div>
		),
	],
} satisfies Meta<typeof ResizablePanel>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Horizontal: Story = {
	args: {
		direction: 'horizontal',
		defaultSize: 200,
		minSize: 100,
		maxSize: 400,
		children: (
			<div
				className="
					flex h-full items-center justify-center bg-bg-secondary p-4
					text-text-primary
				"
			>
				Drag the right edge to resize
			</div>
		),
	},
};

export const Vertical: Story = {
	args: {
		direction: 'vertical',
		defaultSize: 150,
		minSize: 80,
		maxSize: 300,
		children: (
			<div
				className="
					flex h-full items-center justify-center bg-bg-secondary p-4
					text-text-primary
				"
			>
				Drag the bottom edge to resize
			</div>
		),
	},
};

export const HandleAtStart: Story = {
	args: {
		direction: 'vertical',
		defaultSize: 150,
		minSize: 80,
		maxSize: 300,
		handlePosition: 'start',
		children: (
			<div
				className="
					flex h-full items-center justify-center bg-bg-secondary p-4
					text-text-primary
				"
			>
				Handle at the top
			</div>
		),
	},
};
