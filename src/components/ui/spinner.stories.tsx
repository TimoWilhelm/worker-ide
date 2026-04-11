import { Spinner } from './spinner';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Spinner',
	component: Spinner,
	decorators: [
		(Story) => (
			<div className="flex min-h-utility-panel items-center justify-center p-8">
				<Story />
			</div>
		),
	],
	argTypes: {
		size: {
			control: 'select',
			options: ['xs', 'sm', 'md', 'lg', 'xl'],
		},
	},
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		size: 'md',
	},
};

export const ExtraSmall: Story = {
	args: {
		size: 'xs',
	},
};

export const Small: Story = {
	args: {
		size: 'sm',
	},
};

export const Large: Story = {
	args: {
		size: 'lg',
	},
};

export const ExtraLarge: Story = {
	args: {
		size: 'xl',
	},
};

export const AllSizes: Story = {
	render: () => (
		<div className="flex items-center gap-4">
			<Spinner size="xs" />
			<Spinner size="sm" />
			<Spinner size="md" />
			<Spinner size="lg" />
			<Spinner size="xl" />
		</div>
	),
};

export const CustomColors: Story = {
	render: () => (
		<div className="flex items-center gap-4 text-accent">
			<Spinner size="md" />
			<Spinner size="md" className="text-warning" />
			<Spinner size="md" className="text-success" />
			<Spinner size="md" className="text-error" />
		</div>
	),
};
