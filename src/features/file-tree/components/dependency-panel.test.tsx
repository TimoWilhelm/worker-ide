/**
 * Component tests for DependencyPanel accessibility and validation.
 */

import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
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

describe('DependencyPanel validation', () => {
	it('shows error for invalid package name on add', async () => {
		const user = userEvent.setup();
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		await user.click(screen.getByText('Add dependency'));
		const input = screen.getByPlaceholderText('name or name@version');
		await user.type(input, 'INVALID PACKAGE!{Enter}');

		await waitFor(() => {
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
		expect(screen.getByRole('alert').textContent).toMatch(/invalid package name/i);
	});

	it('shows error for invalid version on add', async () => {
		const user = userEvent.setup();
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		await user.click(screen.getByText('Add dependency'));
		const input = screen.getByPlaceholderText('name or name@version');
		await user.type(input, 'lodash@not a version{Enter}');

		await waitFor(() => {
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
		expect(screen.getByRole('alert').textContent).toMatch(/invalid version/i);
	});

	it('shows error when adding a duplicate dependency', async () => {
		const user = userEvent.setup();
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		await user.click(screen.getByText('Add dependency'));
		const input = screen.getByPlaceholderText('name or name@version');
		await user.type(input, 'react{Enter}');

		await waitFor(() => {
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});
		expect(screen.getByRole('alert').textContent).toMatch(/already added/i);
	});

	it('clears add error when input changes', async () => {
		const user = userEvent.setup();
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		await user.click(screen.getByText('Add dependency'));
		const input = screen.getByPlaceholderText('name or name@version');
		await user.type(input, 'INVALID!{Enter}');

		await waitFor(() => {
			expect(screen.getByRole('alert')).toBeInTheDocument();
		});

		await user.type(input, 'a');
		expect(screen.queryByRole('alert')).not.toBeInTheDocument();
	});

	it('marks dependencies as invalid when server-error with not-found dependencyErrors is dispatched', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		const errorEvent = new CustomEvent('server-error', {
			detail: {
				message: 'Build failed',
				dependencyErrors: [{ packageName: 'react', code: 'not-found', message: 'Package not found' }],
			},
		});
		globalThis.dispatchEvent(errorEvent);

		await waitFor(() => {
			const reactRow = screen.getAllByRole('option')[0];
			expect(reactRow).toHaveAttribute('aria-invalid', 'true');
		});
	});

	it('marks dependencies as invalid when server-error with resolve-failed dependencyErrors is dispatched', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		const errorEvent = new CustomEvent('server-error', {
			detail: {
				message: 'Build failed',
				dependencyErrors: [{ packageName: 'zustand', code: 'resolve-failed', message: 'CDN error' }],
			},
		});
		globalThis.dispatchEvent(errorEvent);

		await waitFor(() => {
			const zustandRow = screen.getAllByRole('option')[1];
			expect(zustandRow).toHaveAttribute('aria-invalid', 'true');
		});
	});

	it('adds unregistered dependencies to missing set when server-error is dispatched', async () => {
		render(<DependencyPanel projectId="test" />);

		await waitFor(() => {
			expect(screen.getByText('react')).toBeInTheDocument();
		});

		const errorEvent = new CustomEvent('server-error', {
			detail: {
				message: 'Build failed',
				dependencyErrors: [{ packageName: 'lodash', code: 'unregistered', message: 'Unregistered' }],
			},
		});
		globalThis.dispatchEvent(errorEvent);

		await waitFor(() => {
			expect(screen.getByText(/lodash/)).toBeInTheDocument();
		});
	});
});
