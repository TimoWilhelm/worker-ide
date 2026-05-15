import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmButton } from './confirm-button';

describe('ConfirmButton', () => {
	it('opens the inline confirmation popup and confirms the action', async () => {
		const user = userEvent.setup();
		const onConfirm = vi.fn(async () => {});

		render(
			<ConfirmButton
				title="Confirm archive"
				description="This will archive the current item."
				confirmLabel="Archive now"
				onConfirm={onConfirm}
			>
				Archive item
			</ConfirmButton>,
		);

		await user.click(screen.getByRole('button', { name: 'Archive item' }));

		expect(await screen.findByText('Confirm archive')).toBeInTheDocument();
		expect(screen.getByText('This will archive the current item.')).toBeInTheDocument();

		await user.click(screen.getByRole('button', { name: 'Archive now' }));

		await waitFor(() => expect(onConfirm).toHaveBeenCalledTimes(1));
		await waitFor(() => expect(screen.queryByText('Confirm archive')).not.toBeInTheDocument());
	});

	it('closes without confirming when cancelled', async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		const onConfirm = vi.fn();

		render(
			<ConfirmButton title="Confirm archive" confirmLabel="Archive now" onConfirm={onConfirm}>
				Archive item
			</ConfirmButton>,
		);

		await user.click(screen.getByRole('button', { name: 'Archive item' }));
		await user.click(screen.getByRole('button', { name: 'Cancel' }));

		expect(onConfirm).not.toHaveBeenCalled();
		await waitFor(() => expect(screen.queryByText('Confirm archive')).not.toBeInTheDocument());
	});
});
