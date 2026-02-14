/**
 * Component tests for DiffToolbar.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffToolbar } from './diff-toolbar';

const defaultProperties = {
	path: '/src/main.ts',
	action: 'edit' as const,
	onApprove: vi.fn(),
	onReject: vi.fn(),
	onApproveAll: vi.fn(),
	onRejectAll: vi.fn(),
	isReverting: false,
	canReject: true,
};

describe('DiffToolbar', () => {
	it('renders file path and action label', () => {
		render(<DiffToolbar {...defaultProperties} />);

		expect(screen.getByText('/src/main.ts')).toBeInTheDocument();
		expect(screen.getByText('edit')).toBeInTheDocument();
	});

	it('renders create action label for create action', () => {
		render(<DiffToolbar {...defaultProperties} action="create" />);

		expect(screen.getByText('create')).toBeInTheDocument();
	});

	it('renders delete action label for delete action', () => {
		render(<DiffToolbar {...defaultProperties} action="delete" />);

		expect(screen.getByText('delete')).toBeInTheDocument();
	});

	it('calls onApprove with path when Accept is clicked', () => {
		const onApprove = vi.fn();
		render(<DiffToolbar {...defaultProperties} onApprove={onApprove} />);

		fireEvent.click(screen.getByText('Accept'));
		expect(onApprove).toHaveBeenCalledWith('/src/main.ts');
	});

	it('calls onReject with path when Reject is clicked', () => {
		const onReject = vi.fn();
		render(<DiffToolbar {...defaultProperties} onReject={onReject} />);

		fireEvent.click(screen.getByText('Reject'));
		expect(onReject).toHaveBeenCalledWith('/src/main.ts');
	});

	it('calls onApproveAll when Accept All is clicked', () => {
		const onApproveAll = vi.fn();
		render(<DiffToolbar {...defaultProperties} onApproveAll={onApproveAll} />);

		fireEvent.click(screen.getByText('Accept All'));
		expect(onApproveAll).toHaveBeenCalled();
	});

	it('calls onRejectAll when Reject All is clicked', () => {
		const onRejectAll = vi.fn();
		render(<DiffToolbar {...defaultProperties} onRejectAll={onRejectAll} />);

		fireEvent.click(screen.getByText('Reject All'));
		expect(onRejectAll).toHaveBeenCalled();
	});

	it('disables buttons when isReverting is true', () => {
		render(<DiffToolbar {...defaultProperties} isReverting={true} />);

		const acceptButton = screen.getByText('Accept').closest('button');
		const rejectButton = screen.getByText('Reject').closest('button');

		expect(acceptButton).toBeDisabled();
		expect(rejectButton).toBeDisabled();
	});

	it('disables reject buttons when canReject is false', () => {
		render(<DiffToolbar {...defaultProperties} canReject={false} />);

		const rejectButton = screen.getByText('Reject').closest('button');
		const rejectAllButton = screen.getByText('Reject All').closest('button');

		expect(rejectButton).toBeDisabled();
		expect(rejectAllButton).toBeDisabled();
	});
});
