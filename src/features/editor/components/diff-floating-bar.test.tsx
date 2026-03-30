/**
 * Component tests for DiffFloatingBar.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { DiffFloatingBar } from './diff-floating-bar';

import type { ChangeGroup } from '../lib/diff-decorations';

function createChangeGroups(count: number): ChangeGroup[] {
	return Array.from({ length: count }, (_, index) => ({
		index,
		hunks: [],
		startLine: index + 1,
	}));
}

const defaultProperties = {
	path: '/src/main.ts',
	isReverting: false,
	canReject: true,
	onAcceptAll: vi.fn(),
	onRejectAll: vi.fn(),
};

describe('DiffFloatingBar', () => {
	it('renders correct pending count', () => {
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(5)}
				hunkStatuses={['pending', 'approved', 'pending', 'rejected', 'pending']}
				currentGroupIndex={0}
				onNavigate={vi.fn()}
			/>,
		);

		expect(screen.getByText(/3 pending/)).toBeInTheDocument();
	});

	it('displays correct navigation index', () => {
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(4)}
				hunkStatuses={['pending', 'pending', 'pending', 'pending']}
				currentGroupIndex={2}
				onNavigate={vi.fn()}
			/>,
		);

		expect(screen.getByText(/3 of 4 edits/)).toBeInTheDocument();
	});

	it('calls onNavigate with previous index when prev button clicked', () => {
		const handleNavigate = vi.fn();
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(3)}
				hunkStatuses={['pending', 'pending', 'pending']}
				currentGroupIndex={2}
				onNavigate={handleNavigate}
			/>,
		);

		fireEvent.click(screen.getByLabelText('Previous edit'));
		expect(handleNavigate).toHaveBeenCalledWith(1);
	});

	it('calls onNavigate with next index when next button clicked', () => {
		const handleNavigate = vi.fn();
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(3)}
				hunkStatuses={['pending', 'pending', 'pending']}
				currentGroupIndex={0}
				onNavigate={handleNavigate}
			/>,
		);

		fireEvent.click(screen.getByLabelText('Next edit'));
		expect(handleNavigate).toHaveBeenCalledWith(1);
	});

	it('disables prev button when at first item', () => {
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(3)}
				hunkStatuses={['pending', 'pending', 'pending']}
				currentGroupIndex={0}
				onNavigate={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText('Previous edit')).toBeDisabled();
	});

	it('disables next button when at last item', () => {
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(3)}
				hunkStatuses={['pending', 'pending', 'pending']}
				currentGroupIndex={2}
				onNavigate={vi.fn()}
			/>,
		);

		expect(screen.getByLabelText('Next edit')).toBeDisabled();
	});

	it('displays singular "edit" when only one change group', () => {
		render(
			<DiffFloatingBar
				{...defaultProperties}
				changeGroups={createChangeGroups(1)}
				hunkStatuses={['pending']}
				currentGroupIndex={0}
				onNavigate={vi.fn()}
			/>,
		);

		expect(screen.getByText(/1 of 1 edit/)).toBeInTheDocument();
	});
});
