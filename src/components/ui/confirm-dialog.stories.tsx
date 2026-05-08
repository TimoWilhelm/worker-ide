import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { ConfirmDialog } from './confirm-dialog';
import { GlobalDialogBackdrop } from './global-dialog-backdrop';

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

const ConfirmDialogDemo = ({ variant = 'default' }: { variant?: 'default' | 'danger' | 'warning' }) => {
	const [open, setOpen] = useState(false);

	return (
		<>
			<GlobalDialogBackdrop />
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

const ResourceNameDemo = () => {
	const [open, setOpen] = useState(false);

	return (
		<>
			<GlobalDialogBackdrop />
			<Button variant="danger" onClick={() => setOpen(true)}>
				Delete Project
			</Button>
			<ConfirmDialog
				open={open}
				onOpenChange={setOpen}
				title="Delete project"
				description={
					<>
						Deleting <strong className="text-text-primary">my-awesome-project</strong> is permanent and cannot be undone.
					</>
				}
				resourceName="my-awesome-project"
				confirmLabel="Delete"
				variant="danger"
				onConfirm={() => setOpen(false)}
			/>
		</>
	);
};

export const DangerWithResourceName: Story = {
	render: () => <ResourceNameDemo />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Delete Project/i });
		await userEvent.click(button);

		const body = within(document.body);
		const dialog = await body.findByRole('alertdialog');
		await expect(dialog).toBeInTheDocument();

		await expect(body.getByRole('button', { name: /my-awesome-project/i })).toBeInTheDocument();
		await expect(body.getByPlaceholderText('my-awesome-project')).toBeInTheDocument();

		const confirmButton = body.getByRole('button', { name: /Delete/i });
		await expect(confirmButton).toBeDisabled();

		const input = body.getByRole('textbox');
		await userEvent.type(input, 'my-awesome-project');
		await expect(confirmButton).toBeEnabled();
	},
};
