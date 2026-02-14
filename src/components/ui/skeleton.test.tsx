/**
 * Component tests for Skeleton components.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { Skeleton, FileTreeSkeleton, EditorSkeleton, PanelSkeleton } from './skeleton';

describe('Skeleton', () => {
	it('renders a div with pulse animation', () => {
		const { container } = render(<Skeleton />);
		const element = container.firstChild;
		expect(element).toHaveClass('animate-pulse');
	});

	it('applies custom className', () => {
		// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class name
		const { container } = render(<Skeleton className="custom-skeleton" />);
		const element = container.firstChild;
		expect(element).toHaveClass('custom-skeleton');
	});

	it('passes through additional props', () => {
		const { container } = render(<Skeleton data-testid="test-skeleton" />);
		expect(container.querySelector('[data-testid="test-skeleton"]')).toBeInTheDocument();
	});
});

describe('FileTreeSkeleton', () => {
	it('renders multiple skeleton rows', () => {
		const { container } = render(<FileTreeSkeleton />);
		// Should render 8 rows, each with 2 skeleton elements
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(8);
	});
});

describe('EditorSkeleton', () => {
	it('renders multiple skeleton lines', () => {
		const { container } = render(<EditorSkeleton />);
		// Should render 12 skeleton lines
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons).toHaveLength(12);
	});
});

describe('PanelSkeleton', () => {
	it('renders without label', () => {
		const { container } = render(<PanelSkeleton />);
		const skeletons = container.querySelectorAll('.animate-pulse');
		expect(skeletons.length).toBeGreaterThanOrEqual(1);
	});

	it('renders with label', () => {
		render(<PanelSkeleton label="Loading preview..." />);
		expect(screen.getByText('Loading preview...')).toBeInTheDocument();
	});
});
