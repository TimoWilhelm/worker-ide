/**
 * Create Organization Modal
 *
 * Modal dialog for creating a new organization.
 * Uses better-auth's organization.create() endpoint.
 */

import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { MAX_ORGANIZATION_NAME_LENGTH, MAX_ORGANIZATIONS_PER_USER } from '@shared/constants';

export function CreateOrgModal({
	open,
	onOpenChange,
	organizationCount,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	organizationCount: number;
}) {
	const [name, setName] = useState('');
	const [isCreating, setIsCreating] = useState(false);

	const slug = name
		.toLowerCase()
		.replaceAll(/[^\da-z]+/g, '-')
		.replaceAll(/^-|-$/g, '');

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		if (trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) {
			toast.error(`Name must be ${MAX_ORGANIZATION_NAME_LENGTH} characters or fewer.`);
			return;
		}

		setIsCreating(true);
		try {
			const { data, error } = await authClient.organization.create({
				name: trimmed,
				slug,
			});
			if (error) {
				toast.error(error.message ?? 'Failed to create organization');
				return;
			}
			if (data) {
				await authClient.organization.setActive({ organizationId: data.id });
				globalThis.location.reload();
			}
		} catch {
			toast.error('Failed to create organization');
		} finally {
			setIsCreating(false);
		}
	}, [name, slug]);

	const handleOpenChange = useCallback(
		(value: boolean) => {
			if (!value) {
				setName('');
			}
			onOpenChange(value);
		},
		[onOpenChange],
	);

	return (
		<Modal open={open} onOpenChange={handleOpenChange} title="New organization">
			<ModalBody>
				<label className="mb-1 block text-xs font-medium text-text-secondary">Name</label>
				<input
					type="text"
					value={name}
					onChange={(event) => setName(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter' && name.trim()) {
							void handleCreate();
						}
					}}
					placeholder="My Team"
					maxLength={MAX_ORGANIZATION_NAME_LENGTH}
					disabled={isCreating}
					autoFocus
					className="
						h-9 w-full rounded-md border border-border bg-bg-secondary/60 px-3 text-xs
						text-text-primary backdrop-blur-sm transition-colors
						placeholder:text-text-secondary/50
						focus-within:border-accent
						focus:outline-none
					"
				/>
				{slug && <p className="mt-2 text-xs text-text-secondary/60">Slug: {slug}</p>}
				{organizationCount >= MAX_ORGANIZATIONS_PER_USER && (
					<p className="mt-2 text-xs text-error/80">You have reached the maximum of {MAX_ORGANIZATIONS_PER_USER} organizations.</p>
				)}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => handleOpenChange(false)} disabled={isCreating}>
					Cancel
				</Button>
				<Button
					size="sm"
					onClick={() => void handleCreate()}
					disabled={isCreating || !name.trim() || organizationCount >= MAX_ORGANIZATIONS_PER_USER}
					isLoading={isCreating}
					loadingText="Creating..."
				>
					Create
				</Button>
			</ModalFooter>
		</Modal>
	);
}
