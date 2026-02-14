/**
 * Component tests for ErrorBoundary.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './error-boundary';

// Suppress console.error from ErrorBoundary during tests
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
	consoleSpy.mockClear();
});

function ThrowingComponent({ shouldThrow }: { shouldThrow: boolean }) {
	if (shouldThrow) {
		throw new Error('Test error');
	}
	return <div>Content renders fine</div>;
}

function TestFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div>
			<p>Error caught: {error.message}</p>
			<button onClick={resetErrorBoundary}>Reset</button>
		</div>
	);
}

describe('ErrorBoundary', () => {
	it('renders children when no error occurs', () => {
		render(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={false} />
			</ErrorBoundary>,
		);

		expect(screen.getByText('Content renders fine')).toBeInTheDocument();
	});

	it('renders fallback when an error occurs', () => {
		render(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={true} />
			</ErrorBoundary>,
		);

		expect(screen.getByText('Error caught: Test error')).toBeInTheDocument();
	});

	it('resets error state when reset button is clicked', () => {
		const { rerender } = render(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={true} />
			</ErrorBoundary>,
		);

		expect(screen.getByText('Error caught: Test error')).toBeInTheDocument();

		// First update the children so ThrowingComponent won't throw on re-render.
		// The fallback is still shown because hasError is still true.
		rerender(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={false} />
			</ErrorBoundary>,
		);

		// Now click Reset which sets hasError=false, causing the boundary
		// to render its (now non-throwing) children.
		fireEvent.click(screen.getByText('Reset'));

		expect(screen.getByText('Content renders fine')).toBeInTheDocument();
	});
});
