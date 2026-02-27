/**
 * Component tests for Spinner.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Spinner } from './spinner';

describe('Spinner', () => {
	it('renders with accessible role', () => {
		render(<Spinner />);
		expect(screen.getByRole('status')).toBeInTheDocument();
	});

	it('has accessible label', () => {
		render(<Spinner />);
		expect(screen.getByLabelText('Loading')).toBeInTheDocument();
	});

	it('has screen reader text', () => {
		render(<Spinner />);
		expect(screen.getByText('Loading...')).toBeInTheDocument();
	});

	it('applies size variant classes', () => {
		const { container } = render(<Spinner size="lg" />);
		const spinner = container.querySelector('[role="status"]');
		expect(spinner?.className).toContain('size-8');
	});

	it('applies custom className', () => {
		const { container } = render(<Spinner className="custom" />);
		const spinner = container.querySelector('[role="status"]');
		expect(spinner?.className).toContain('custom');
	});
});
