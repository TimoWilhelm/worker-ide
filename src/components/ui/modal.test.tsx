import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog';
import { GlobalDialogBackdrop } from './global-dialog-backdrop';
import { Modal, ModalBody, ModalFooter } from './modal';

describe('Modal', () => {
	it('renders title and children when open', () => {
		render(
			<Modal open={true} onOpenChange={vi.fn()} title="New File">
				<p>Enter file name</p>
			</Modal>,
		);

		expect(screen.getByText('New File')).toBeInTheDocument();
		expect(screen.getByText('Enter file name')).toBeInTheDocument();
	});

	it('does not render content when closed', () => {
		render(
			<Modal open={false} onOpenChange={vi.fn()} title="Hidden">
				<p>Should not appear</p>
			</Modal>,
		);

		expect(screen.queryByText('Hidden')).not.toBeInTheDocument();
		expect(screen.queryByText('Should not appear')).not.toBeInTheDocument();
	});

	it('renders close button', () => {
		render(
			<Modal open={true} onOpenChange={vi.fn()} title="Test">
				<p>Content</p>
			</Modal>,
		);

		// The close button renders a × character
		expect(screen.getByText('×')).toBeInTheDocument();
	});

	it('shows a single shared backdrop element regardless of how many modals are active', () => {
		render(
			<>
				<GlobalDialogBackdrop />
				<Modal open={true} onOpenChange={vi.fn()} title="First">
					<p>First content</p>
				</Modal>
				<Modal open={true} onOpenChange={vi.fn()} title="Second">
					<p>Second content</p>
				</Modal>
				<ConfirmDialog open={true} onOpenChange={vi.fn()} title="Confirm" description="Are you sure?" onConfirm={vi.fn()} />
			</>,
		);

		const backdrops = screen.getAllByTestId('modal-backdrop');
		expect(backdrops).toHaveLength(1);
	});

	it('keeps the same backdrop element mounted while switching between modals', async () => {
		const user = userEvent.setup();

		function ModalSwitchExample() {
			const [settingsOpen, setSettingsOpen] = useState(true);
			const [deleteOpen, setDeleteOpen] = useState(false);

			return (
				<>
					<GlobalDialogBackdrop />
					<Modal open={settingsOpen} onOpenChange={setSettingsOpen} title="Project Settings">
						<ModalBody>
							<button
								onClick={() => {
									setSettingsOpen(false);
									setDeleteOpen(true);
								}}
							>
								Delete Project
							</button>
						</ModalBody>
					</Modal>
					<Modal open={deleteOpen} onOpenChange={setDeleteOpen} title="Delete project">
						<ModalBody>Confirm delete</ModalBody>
					</Modal>
				</>
			);
		}

		render(<ModalSwitchExample />);

		const backdropBefore = screen.getByTestId('modal-backdrop');

		await user.click(screen.getByRole('button', { name: 'Delete Project' }));

		expect(screen.getByRole('dialog', { hidden: true, name: 'Delete project' })).toBeInTheDocument();
		const backdropAfter = screen.getByTestId('modal-backdrop');
		expect(backdropAfter).toBe(backdropBefore);
	});
});

describe('ModalBody', () => {
	it('renders children with padding', () => {
		const { container } = render(
			<ModalBody>
				<p>Body content</p>
			</ModalBody>,
		);

		expect(screen.getByText('Body content')).toBeInTheDocument();
		expect(container.firstChild).toHaveClass('p-4');
	});

	it('applies custom className', () => {
		const { container } = render(
			<ModalBody className="custom-body">
				<p>Content</p>
			</ModalBody>,
		);

		expect(container.firstChild).toHaveClass('custom-body');
	});
});

describe('ModalFooter', () => {
	it('renders children', () => {
		render(
			<ModalFooter>
				<button>Save</button>
			</ModalFooter>,
		);

		expect(screen.getByText('Save')).toBeInTheDocument();
	});

	it('has flex layout', () => {
		const { container } = render(
			<ModalFooter>
				<button>OK</button>
			</ModalFooter>,
		);

		expect(container.firstChild).toHaveClass('flex');
	});
});
