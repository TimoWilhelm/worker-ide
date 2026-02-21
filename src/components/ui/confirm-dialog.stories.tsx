import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { ConfirmDialog } from './confirm-dialog';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/ConfirmDialog',
	component: ConfirmDialog,
	parameters: {
		layout: 'centered',
	},
	args: {
		open: false,
		onOpenChange: () => {},
		title: '',
		description: '',
		onConfirm: () => {},
	},
} satisfies Meta<typeof ConfirmDialog>;

export default meta;
type Story = StoryObj<typeof meta>;

const ConfirmDialogDemo = ({ variant = 'default' }: { variant?: 'default' | 'danger' }) => {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button variant={variant === 'danger' ? 'danger' : 'default'} onClick={() => setOpen(true)}>
				Open Confirm Dialog
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Are you absolutely sure?"
				description="This action cannot be undone. This will permanently delete your account and remove your data from our servers."
				variant={variant}
				onConfirm={() => setOpen(false)}
			/>
		</>
	);
};

export const Default: Story = {
	render: () => <ConfirmDialogDemo />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Open Confirm Dialog/i });
		await userEvent.click(button);

		const body = within(document.body);
		const dialog = await body.findByRole('alertdialog');
		await expect(dialog).toBeInTheDocument();

		const title = body.getByText('Are you absolutely sure?');
		await expect(title).toBeInTheDocument();

		const cancel = body.getByRole('button', { name: /Cancel/i });
		await userEvent.click(cancel);
	},
};

export const Danger: Story = {
	render: () => <ConfirmDialogDemo variant="danger" />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Open Confirm Dialog/i });
		await userEvent.click(button);

		const body = within(document.body);
		const dialog = await body.findByRole('alertdialog');
		await expect(dialog).toBeInTheDocument();

		const confirm = body.getByRole('button', { name: /Confirm/i });
		await userEvent.click(confirm);
	},
};
