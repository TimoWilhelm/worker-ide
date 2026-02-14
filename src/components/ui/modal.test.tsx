/**
 * Component tests for Modal.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

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
});

describe('ModalBody', () => {
	it('renders children with padding', () => {
		const { container } = render(
			<ModalBody>
				<p>Body content</p>
			</ModalBody>,
		);

		expect(screen.getByText('Body content')).toBeInTheDocument();
		expect(container.firstChild).toHaveClass('px-4', 'py-4');
	});

	it('applies custom className', () => {
		const { container } = render(
			// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class name
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
