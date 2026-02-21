import { Spinner } from './spinner';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Spinner',
	component: Spinner,
	argTypes: {
		size: {
			control: 'select',
			options: ['sm', 'md', 'lg', 'xl'],
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
			<Spinner size="sm" />
			<Spinner size="md" />
			<Spinner size="lg" />
			<Spinner size="xl" />
		</div>
	),
};
