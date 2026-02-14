/**
 * Component tests for ConfirmDialog.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';

describe('ConfirmDialog', () => {
	it('renders title and description when open', () => {
		render(
			<ConfirmDialog
				open={true}
				onOpenChange={vi.fn()}
				title="Delete file?"
				description="This action cannot be undone."
				onConfirm={vi.fn()}
			/>,
		);

		expect(screen.getByText('Delete file?')).toBeInTheDocument();
		expect(screen.getByText('This action cannot be undone.')).toBeInTheDocument();
	});

	it('renders default button labels', () => {
		render(<ConfirmDialog open={true} onOpenChange={vi.fn()} title="Action required" description="Are you sure?" onConfirm={vi.fn()} />);

		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Confirm' })).toBeInTheDocument();
	});

	it('renders custom button labels', () => {
		render(
			<ConfirmDialog
				open={true}
				onOpenChange={vi.fn()}
				title="Delete"
				description="Sure?"
				confirmLabel="Yes, delete"
				cancelLabel="No, keep"
				onConfirm={vi.fn()}
			/>,
		);

		expect(screen.getByText('Yes, delete')).toBeInTheDocument();
		expect(screen.getByText('No, keep')).toBeInTheDocument();
	});

	it('calls onConfirm when confirm button is clicked', () => {
		const onConfirm = vi.fn();
		render(
			<ConfirmDialog open={true} onOpenChange={vi.fn()} title="Are you sure?" description="This will proceed." onConfirm={onConfirm} />,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
		expect(onConfirm).toHaveBeenCalledOnce();
	});

	it('does not render content when closed', () => {
		render(<ConfirmDialog open={false} onOpenChange={vi.fn()} title="Hidden title" description="Hidden description" onConfirm={vi.fn()} />);

		expect(screen.queryByText('Hidden title')).not.toBeInTheDocument();
	});

	it('applies danger variant styling to confirm button', () => {
		render(
			<ConfirmDialog
				open={true}
				onOpenChange={vi.fn()}
				title="Remove file"
				description="Sure?"
				variant="danger"
				confirmLabel="Delete"
				onConfirm={vi.fn()}
			/>,
		);

		const confirmButton = screen.getByRole('button', { name: 'Delete' });
		expect(confirmButton.className).toContain('bg-error');
	});
});
