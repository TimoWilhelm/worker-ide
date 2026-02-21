import { useState } from 'react';

import { ErrorBoundary } from './error-boundary';

import type { Meta, StoryObj } from '@storybook/react-vite';

const meta = {
	title: 'Components/ErrorBoundary',
	component: ErrorBoundary,
} satisfies Meta<typeof ErrorBoundary>;

export default meta;
type Story = StoryObj<typeof meta>;

function ErrorFallback({ error, resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div className="rounded-lg border border-error bg-bg-secondary p-6">
			<h2 className="mb-2 text-lg font-semibold text-error">Something went wrong</h2>
			<pre
				className="
					mb-4 rounded-sm bg-bg-tertiary p-3 font-mono text-sm text-text-secondary
				"
			>
				{error.message}
			</pre>
			<button
				onClick={resetErrorBoundary}
				className="
					rounded-sm bg-accent px-4 py-2 text-sm text-white
					hover:bg-accent-hover
				"
			>
				Try again
			</button>
		</div>
	);
}

function NormalChild() {
	return (
		<div className="rounded-lg border border-border bg-bg-secondary p-6">
			<p className="text-text-primary">This content renders normally. No errors here.</p>
		</div>
	);
}

function ErrorThrowingChild(): React.ReactNode {
	throw new Error('This is a simulated error for demonstration purposes');
}

function ToggleableError() {
	const [shouldError, setShouldError] = useState(false);

	if (shouldError) {
		throw new Error('User triggered error');
	}

	return (
		<div className="rounded-lg border border-border bg-bg-secondary p-6">
			<p className="mb-4 text-text-primary">Click the button to trigger an error:</p>
			<button
				onClick={() => setShouldError(true)}
				className="
					rounded-sm bg-error px-4 py-2 text-sm text-white
					hover:bg-red-600
				"
			>
				Trigger Error
			</button>
		</div>
	);
}

export const Normal: Story = {
	args: {
		fallback: ErrorFallback,
		children: <NormalChild />,
	},
};

export const WithError: Story = {
	args: {
		fallback: ErrorFallback,
		children: <ErrorThrowingChild />,
	},
};

export const Interactive: Story = {
	args: {
		fallback: ErrorFallback,
		children: <ToggleableError />,
	},
	render: () => (
		<ErrorBoundary fallback={ErrorFallback}>
			<ToggleableError />
		</ErrorBoundary>
	),
};
