import { useState } from 'react';
import { expect, userEvent, within } from 'storybook/test';

import { Button } from './button';
import { Modal, ModalBody, ModalFooter } from './modal';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'UI/Modal',
	component: Modal,
	parameters: {
		layout: 'centered',
	},
	args: {
		open: false,
		onOpenChange: () => {},
		title: '',
		children: undefined,
	},
} satisfies Meta<typeof Modal>;

export default meta;
type Story = StoryObj<typeof meta>;

const ModalDemo = () => {
	const [open, setOpen] = useState(false);

	return (
		<>
			<Button onClick={() => setOpen(true)}>Open Modal</Button>
			<Modal open={open} onOpenChange={setOpen} title="Edit Profile">
				<ModalBody>
					<div className="flex flex-col gap-4">
						<p className="text-sm text-text-secondary">Make changes to your profile here. Click save when you're done.</p>
						<div className="flex flex-col gap-2">
							<label className="text-sm font-medium">Name</label>
							<input
								className="
									rounded-md border border-border bg-bg-primary px-3 py-2 text-sm
								"
								defaultValue="Alex"
							/>
						</div>
					</div>
				</ModalBody>
				<ModalFooter>
					<Button onClick={() => setOpen(false)}>Save Changes</Button>
				</ModalFooter>
			</Modal>
		</>
	);
};

export const Default: Story = {
	render: () => <ModalDemo />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		const button = canvas.getByRole('button', { name: /Open Modal/i });
		await userEvent.click(button);

		const body = within(document.body);
		const dialog = await body.findByRole('dialog');
		await expect(dialog).toBeInTheDocument();

		const title = body.getByText('Edit Profile');
		await expect(title).toBeInTheDocument();

		const saveButton = body.getByRole('button', { name: /Save Changes/i });
		await userEvent.click(saveButton);
	},
};
