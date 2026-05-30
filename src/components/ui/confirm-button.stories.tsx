import { useState } from 'react';
import { expect, userEvent, waitFor, within } from 'storybook/test';

import { ConfirmButton } from './confirm-button';

import type { Meta, StoryObj } from '@storybook/react-vite';

function ConfirmButtonDemo() {
	const [confirmationCount, setConfirmationCount] = useState(0);

	return (
		<div className="flex flex-col items-end gap-3">
			<ConfirmButton
				title="Sign out all other sessions?"
				description="Your current session stays active. Every other device will need to sign in again."
				confirmLabel="Sign out others"
				onConfirm={() => setConfirmationCount((currentValue) => currentValue + 1)}
				variant="outline"
			>
				Sign out all others
			</ConfirmButton>
			<p className="text-xs text-text-secondary">Confirmed: {confirmationCount}</p>
		</div>
	);
}

const meta = {
	title: 'UI/ConfirmButton',
	component: ConfirmButton,
	parameters: {
		layout: 'centered',
	},
	args: {
		children: 'Open confirm',
		title: 'Confirm action?',
		confirmLabel: 'Confirm',
		onConfirm: () => {},
	},
} satisfies Meta<typeof ConfirmButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
	render: () => <ConfirmButtonDemo />,
	play: async ({ canvasElement }) => {
		const canvas = within(canvasElement);
		await userEvent.click(canvas.getByRole('button', { name: 'Sign out all others' }));

		const body = within(document.body);
		const dialog = body.getByRole('dialog');
		await expect(body.getByText('Sign out all other sessions?')).toBeInTheDocument();
		await waitFor(() => {
			if (globalThis.getComputedStyle(dialog).pointerEvents !== 'auto') {
				throw new Error('Confirm dialog is not interactive yet');
			}
		});

		await userEvent.click(body.getByRole('button', { name: 'Sign out others' }));
		await expect(canvas.getByText('Confirmed: 1')).toBeInTheDocument();
	},
};
