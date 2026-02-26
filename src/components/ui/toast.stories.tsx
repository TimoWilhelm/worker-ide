import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { Toaster } from './toast';
import { toast } from './toast-store';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Toast',
	component: Toaster,
	parameters: {
		layout: 'centered',
	},
} satisfies Meta<typeof Toaster>;

export default meta;
type Story = StoryObj<typeof meta>;

const ToastDemo = () => {
	return (
		<div className="flex flex-col gap-4">
			<Button
				onClick={() => {
					toast.error('Something went wrong!');
				}}
			>
				Show Error Toast
			</Button>
			<Button
				onClick={() => {
					toast.success('File saved!');
				}}
			>
				Show Success Toast
			</Button>
			<Button
				onClick={() => {
					toast.info('New version available', {
						action: {
							label: 'Reload',
							onClick: () => globalThis.location.reload(),
						},
					});
				}}
			>
				Show Info Toast with Action
			</Button>
			<Toaster />
		</div>
	);
};

export const Default: Story = {
	render: () => <ToastDemo />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const errorButton = canvas.getByRole('button', { name: /Show Error Toast/i });
		await userEvent.click(errorButton);

		const body = within(document.body);
		const errorText = await body.findByText('Something went wrong!');
		await expect(errorText).toBeInTheDocument();
	},
};
