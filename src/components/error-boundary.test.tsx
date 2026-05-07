import { render, screen, fireEvent } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { isUpdateActivationReloadPendingMock, recoverFromStaleAssetMock } = vi.hoisted(() => ({
	isUpdateActivationReloadPendingMock: vi.fn(() => false),
	recoverFromStaleAssetMock: vi.fn(),
}));

vi.mock('@/lib/stale-asset-recovery', () => ({
	isDynamicImportFailure: (error: unknown) => error instanceof Error && error.message === 'Failed to fetch dynamically imported module',
	isUpdateActivationReloadPending: isUpdateActivationReloadPendingMock,
	recoverFromStaleAsset: recoverFromStaleAssetMock,
}));

import { ErrorBoundary } from './error-boundary';

// Suppress console.error from ErrorBoundary during tests
const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
	consoleSpy.mockClear();
	isUpdateActivationReloadPendingMock.mockReset();
	isUpdateActivationReloadPendingMock.mockReturnValue(false);
	recoverFromStaleAssetMock.mockClear();
});

function ThrowingComponent({ message = 'Test error', shouldThrow }: { message?: string; shouldThrow: boolean }) {
	if (shouldThrow) {
		throw new Error(message);
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

	it('triggers stale asset recovery for dynamic import failures', () => {
		render(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={true} message="Failed to fetch dynamically imported module" />
			</ErrorBoundary>,
		);

		expect(recoverFromStaleAssetMock).toHaveBeenCalledTimes(1);
		expect(screen.getByText('Error caught: Failed to fetch dynamically imported module')).toBeInTheDocument();
	});

	it('suppresses the fallback during an update-triggered reload handoff', () => {
		isUpdateActivationReloadPendingMock.mockReturnValue(true);

		render(
			<ErrorBoundary fallback={TestFallback}>
				<ThrowingComponent shouldThrow={true} message="Failed to fetch dynamically imported module" />
			</ErrorBoundary>,
		);

		expect(recoverFromStaleAssetMock).toHaveBeenCalledTimes(1);
		expect(screen.queryByText('Error caught: Failed to fetch dynamically imported module')).not.toBeInTheDocument();
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
