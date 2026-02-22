import { Check, ClipboardCopy } from 'lucide-react';
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
	const [copied, setCopied] = useState(false);

	function handleCopy() {
		void navigator.clipboard.writeText(error.message).then(() => {
			setCopied(true);
			setTimeout(() => setCopied(false), 2000);
		});
	}

	return (
		<div className="rounded-lg border border-error bg-bg-secondary p-6">
			<div className="mb-2 flex items-center justify-between">
				<h2 className="text-lg font-semibold text-error">Something went wrong</h2>
				<button
					onClick={handleCopy}
					title="Copy error to clipboard"
					className="
						cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
						hover:bg-bg-tertiary hover:text-text-primary
					"
				>
					{copied ? <Check className="size-4 text-green-500" /> : <ClipboardCopy className="size-4" />}
				</button>
			</div>
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
