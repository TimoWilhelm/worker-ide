import { expect, userEvent, within } from '@storybook/test';

import { Button } from './button';
import { Toaster } from './toast';
import { addToast } from './toast-store';

import type { Meta, StoryObj } from '@storybook/react';

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
					addToast('Something went wrong!');
				}}
			>
				Show Error Toast
			</Button>
			<Button
				onClick={() => {
					addToast('Success: File saved!', 'success');
				}}
			>
				Show Success Toast
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
