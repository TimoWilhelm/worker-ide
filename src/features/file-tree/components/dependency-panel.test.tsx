/**
 * Component tests for DependencyPanel accessibility.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/api-client', () => ({
	fetchProjectMeta: vi.fn().mockResolvedValue({
		dependencies: { react: '19.0.0', zustand: '5.0.0' },
	}),
	updateDependencies: vi.fn().mockResolvedValue({}),
}));

import { DependencyPanel } from './dependency-panel';

describe('DependencyPanel accessibility', () => {
	it('edit and remove buttons have aria-labels', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		expect(screen.getByLabelText('Edit version for react')).toBeInTheDocument();
		expect(screen.getByLabelText('Remove react')).toBeInTheDocument();
		expect(screen.getByLabelText('Edit version for zustand')).toBeInTheDocument();
		expect(screen.getByLabelText('Remove zustand')).toBeInTheDocument();
	});

	it('action buttons are not in the tab order', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		const editButton = screen.getByLabelText('Edit version for react');
		expect(editButton).toHaveAttribute('tabindex', '-1');

		const removeButton = screen.getByLabelText('Remove react');
		expect(removeButton).toHaveAttribute('tabindex', '-1');
	});

	it('dependency rows support ArrowDown/ArrowUp navigation', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		const rows = screen.getAllByRole('option');
		rows[0].focus();
		expect(document.activeElement).toBe(rows[0]);

		fireEvent.keyDown(rows[0], { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rows[1]);

		fireEvent.keyDown(rows[1], { key: 'ArrowUp' });
		expect(document.activeElement).toBe(rows[0]);
	});

	it('collapsed header has an accessible label', () => {
		render(<DependencyPanel projectId="test" collapsed onToggle={vi.fn()} />);

		expect(screen.getByLabelText('Show dependencies')).toBeInTheDocument();
	});
});
