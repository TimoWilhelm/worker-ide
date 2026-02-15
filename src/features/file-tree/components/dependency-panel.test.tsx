/**
 * Component tests for DependencyPanel accessibility.
 */

import { render, screen, waitFor } from '@testing-library/react';
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

	it('collapsed header has an accessible label', () => {
		render(<DependencyPanel projectId="test" collapsed onToggle={vi.fn()} />);

		expect(screen.getByLabelText('Show dependencies')).toBeInTheDocument();
	});
});
