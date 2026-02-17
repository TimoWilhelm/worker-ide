/**
 * Git Branch Dialog
 *
 * Modal for creating a new branch.
 */

import { useState } from 'react';

import { Button, Modal, ModalBody, ModalFooter } from '@/components/ui';
import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

interface GitBranchDialogProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreateBranch: (name: string, checkout: boolean) => void;
	isPending: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function GitBranchDialog({ open, onOpenChange, onCreateBranch, isPending }: GitBranchDialogProperties) {
	const [name, setName] = useState('');
	const [checkout, setCheckout] = useState(true);

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed.length === 0) {
			return;
		}
		onCreateBranch(trimmed, checkout);
		setName('');
	};

	return (
		<Modal
			open={open}
			onOpenChange={(value) => {
				if (!value) setName('');
				onOpenChange(value);
			}}
			title="Create Branch"
		>
			<form onSubmit={handleSubmit}>
				<ModalBody>
					<label className="flex flex-col gap-1.5">
						<span className="text-xs font-medium text-text-secondary">Branch Name</span>
						<input
							type="text"
							value={name}
							onChange={(event) => setName(event.target.value)}
							placeholder="feature/my-feature"
							autoFocus
							className={cn(
								'w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm',
								`
									text-text-primary
									placeholder:text-text-secondary
								`,
								'focus:border-accent focus:outline-none',
							)}
						/>
					</label>
					<label className="mt-3 flex items-center gap-2 text-sm text-text-primary">
						<input type="checkbox" checked={checkout} onChange={(event) => setCheckout(event.target.checked)} className="accent-accent" />
						Switch to new branch
					</label>
				</ModalBody>
				<ModalFooter>
					<Button variant="ghost" size="sm" type="button" onClick={() => onOpenChange(false)}>
						Cancel
					</Button>
					<Button variant="default" size="sm" type="submit" isLoading={isPending} disabled={name.trim().length === 0 || isPending}>
						Create
					</Button>
				</ModalFooter>
			</form>
		</Modal>
	);
}
