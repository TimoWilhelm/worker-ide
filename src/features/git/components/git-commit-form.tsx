/**
 * Git Commit Form
 *
 * Input area for composing commit messages with a commit button.
 */

import { Check } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/components/ui';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface GitCommitFormProperties {
	onCommit: (message: string) => void;
	isCommitting: boolean;
	isCommitSuccess: boolean;
	hasStagedChanges: boolean;
	error?: Error | undefined;
}

// =============================================================================
// Component
// =============================================================================

export function GitCommitForm({ onCommit, isCommitting, isCommitSuccess, hasStagedChanges, error }: GitCommitFormProperties) {
	const [message, setMessage] = useState('');
	const [previousCommitSuccess, setPreviousCommitSuccess] = useState(isCommitSuccess);

	// Clear the commit message when a commit succeeds.
	// Set state during rendering (not in an effect) per React best practices:
	// "To reset a particular bit of state in response to a prop change, set it during rendering."
	if (isCommitSuccess !== previousCommitSuccess) {
		setPreviousCommitSuccess(isCommitSuccess);
		if (isCommitSuccess) {
			setMessage('');
		}
	}

	const handleSubmit = () => {
		const trimmed = message.trim();
		if (trimmed.length === 0) {
			return;
		}
		onCommit(trimmed);
	};

	const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
		if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
			event.preventDefault();
			handleSubmit();
		}
	};

	return (
		<div className="flex flex-col gap-2 px-3 py-2">
			<textarea
				value={message}
				onChange={(event) => setMessage(event.target.value)}
				onKeyDown={handleKeyDown}
				placeholder="Commit message"
				rows={3}
				className={cn(
					`
						w-full resize-none rounded-md border border-border bg-bg-primary px-3 py-2
						text-sm
					`,
					`
						text-text-primary
						placeholder:text-text-secondary
					`,
					'focus:border-accent focus:outline-none',
				)}
			/>
			{error && <p className="text-xs text-error">{error.message}</p>}
			<Button
				variant="default"
				size="sm"
				onClick={handleSubmit}
				isLoading={isCommitting}
				loadingText="Committing..."
				disabled={message.trim().length === 0 || !hasStagedChanges || isCommitting}
				className="w-full"
			>
				<Check className="size-3.5" />
				Commit
			</Button>
			{!hasStagedChanges && message.trim().length > 0 && <p className="text-xs text-text-secondary">Stage changes before committing</p>}
		</div>
	);
}
