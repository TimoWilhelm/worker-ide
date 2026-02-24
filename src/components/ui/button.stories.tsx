import { Download, Plus, Trash2 } from 'lucide-react';

import { Button } from './button';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Button',
	component: Button,
	argTypes: {
		variant: {
			control: 'select',
			options: ['default', 'secondary', 'ghost', 'danger', 'warning', 'outline'],
		},
		size: {
			control: 'select',
			options: ['sm', 'md', 'lg', 'icon', 'icon-sm'],
		},
		isLoading: { control: 'boolean' },
		disabled: { control: 'boolean' },
	},
} satisfies Meta<typeof Button>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	args: {
		children: 'Button',
		variant: 'default',
		size: 'md',
	},
};

export const Secondary: Story = {
	args: {
		children: 'Secondary',
		variant: 'secondary',
	},
};

export const Ghost: Story = {
	args: {
		children: 'Ghost',
		variant: 'ghost',
	},
};

export const Danger: Story = {
	args: {
		children: 'Delete',
		variant: 'danger',
	},
};

export const Warning: Story = {
	args: {
		children: 'Warning',
		variant: 'warning',
	},
};

export const Outline: Story = {
	args: {
		children: 'Outline',
		variant: 'outline',
	},
};

export const Small: Story = {
	args: {
		children: 'Small',
		size: 'sm',
	},
};

export const Large: Story = {
	args: {
		children: 'Large',
		size: 'lg',
	},
};

export const IconButton: Story = {
	args: {
		children: <Plus className="size-4" />,
		size: 'icon',
		variant: 'ghost',
	},
};

export const Loading: Story = {
	args: {
		children: 'Save',
		isLoading: true,
	},
};

export const LoadingWithText: Story = {
	args: {
		children: 'Save',
		isLoading: true,
		loadingText: 'Saving...',
	},
};

export const Disabled: Story = {
	args: {
		children: 'Disabled',
		disabled: true,
	},
};

export const WithIcon: Story = {
	args: {
		children: (
			<>
				<Download className="size-4" />
				Download
			</>
		),
	},
};

export const AllVariants: Story = {
	render: () => (
		<div className="flex flex-wrap items-center gap-3">
			<Button variant="default">Default</Button>
			<Button variant="secondary">Secondary</Button>
			<Button variant="ghost">Ghost</Button>
			<Button variant="danger">Danger</Button>
			<Button variant="warning">Warning</Button>
			<Button variant="outline">Outline</Button>
		</div>
	),
};

export const AllSizes: Story = {
	render: () => (
		<div className="flex flex-wrap items-center gap-3">
			<Button size="sm">Small</Button>
			<Button size="md">Medium</Button>
			<Button size="lg">Large</Button>
			<Button size="icon">
				<Plus className="size-4" />
			</Button>
			<Button size="icon-sm">
				<Trash2 className="size-3" />
			</Button>
		</div>
	),
};
