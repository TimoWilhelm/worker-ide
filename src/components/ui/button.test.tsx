/**
 * Component tests for Button.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { Button } from './button';

describe('Button', () => {
	it('renders children', () => {
		render(<Button>Click me</Button>);
		expect(screen.getByRole('button', { name: 'Click me' })).toBeInTheDocument();
	});

	it('handles click events', () => {
		const handleClick = vi.fn();
		render(<Button onClick={handleClick}>Click</Button>);

		fireEvent.click(screen.getByRole('button'));
		expect(handleClick).toHaveBeenCalledOnce();
	});

	it('disables when disabled prop is true', () => {
		render(<Button disabled>Disabled</Button>);
		expect(screen.getByRole('button')).toBeDisabled();
	});

	it('disables when isLoading is true', () => {
		render(<Button isLoading>Loading</Button>);
		expect(screen.getByRole('button')).toBeDisabled();
	});

	it('shows loading text when isLoading and loadingText provided', () => {
		render(
			<Button isLoading loadingText="Please wait...">
				Submit
			</Button>,
		);
		expect(screen.getByRole('button')).toHaveTextContent('Please wait...');
	});

	it('applies variant classes', () => {
		const { container } = render(<Button variant="danger">Delete</Button>);
		const button = container.querySelector('button');
		expect(button?.className).toContain('bg-red-600');
	});

	it('applies size classes', () => {
		const { container } = render(<Button size="lg">Large</Button>);
		const button = container.querySelector('button');
		expect(button?.className).toContain('py-2');
	});

	it('supports ref-as-prop (React 19)', () => {
		const reference = createRef<HTMLButtonElement>();
		render(<Button ref={reference}>Ref button</Button>);
		expect(reference.current).toBeInstanceOf(HTMLButtonElement);
	});

	it('applies custom className', () => {
		// eslint-disable-next-line better-tailwindcss/no-unknown-classes -- test-only fake class name
		const { container } = render(<Button className="custom-class">Custom</Button>);
		const button = container.querySelector('button');
		expect(button?.className).toContain('custom-class');
	});
});
