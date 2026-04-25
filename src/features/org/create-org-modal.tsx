import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { MAX_ORGANIZATION_NAME_LENGTH } from '@shared/constants';

function isSlugConflictError(error: { code?: string; message?: string } | null | undefined): boolean {
	return error?.code === 'ORGANIZATION_ALREADY_EXISTS' || error?.code === 'ORGANIZATION_SLUG_ALREADY_TAKEN';
}

export function CreateOrgModal({
	open,
	onOpenChange,
	freeOrganizationCount,
	maxFreeOrganizations,
	required,
	userName,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	freeOrganizationCount: number;
	maxFreeOrganizations?: number;
	required?: boolean;
	userName?: string;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const { refetch: refetchOrganizations } = authClient.useListOrganizations();
	const { refetch: refetchActiveOrganization } = authClient.useActiveOrganization();
	const defaultName = required && userName ? `${userName}'s Workspace` : '';
	const [name, setName] = useState(defaultName);
	const [isCreating, setIsCreating] = useState(false);
	const resolvedMax = maxFreeOrganizations ?? 3;
	const isAtLimit = freeOrganizationCount >= resolvedMax;

	const handleOpenChange = useCallback(
		(value: boolean) => {
			if (!value && required) return;
			if (!value) {
				setName(defaultName);
			}
			onOpenChange(value);
		},
		[defaultName, onOpenChange, required],
	);

	const handleCreate = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		if (trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) {
			toast.error(`Name must be ${MAX_ORGANIZATION_NAME_LENGTH} characters or fewer.`);
			return;
		}

		setIsCreating(true);
		try {
			let createResult: Awaited<ReturnType<typeof authClient.organization.create>> | undefined;

			for (let attempt = 0; attempt < 2; attempt++) {
				createResult = await authClient.organization.create({
					name: trimmed,
					slug: crypto.randomUUID(),
				});

				if (!createResult.error || !isSlugConflictError(createResult.error)) {
					break;
				}
			}

			const { data, error } = createResult ?? {};
			if (error) {
				toast.error(error.message ?? 'Failed to create organization. Please try again.');
				return;
			}
			if (data) {
				const orgSlug = data.slug;
				if (!orgSlug) {
					toast.error('Created organization is missing its slug. Please refresh and try again.');
					return;
				}
				try {
					await authClient.organization.setActive({ organizationId: data.id });
				} catch {
					// Activation failed but the org was created — navigate anyway.
					// The next page load will resolve the active org from the URL.
				}
				globalThis.localStorage.setItem('lastOrgSlug', orgSlug);
				handleOpenChange(false);
				toast.success('Organization created');
				void navigate(`/org/${orgSlug}`);
				void Promise.allSettled([
					refetchOrganizations(),
					refetchActiveOrganization(),
					queryClient.invalidateQueries({ queryKey: ['user-limits'] }),
				]);
			}
		} catch {
			toast.error('Could not create the organization. Please check your connection and try again.');
		} finally {
			setIsCreating(false);
		}
	}, [handleOpenChange, name, navigate, queryClient, refetchActiveOrganization, refetchOrganizations]);

	return (
		<Modal
			open={open}
			onOpenChange={handleOpenChange}
			title={required ? 'Create an organization' : 'New organization'}
			hideClose={required}
		>
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
				{isAtLimit && <p className="mt-2 text-xs text-error/80">Maximum number of organizations reached.</p>}
			</ModalBody>
			<ModalFooter>
				{!required && (
					<Button variant="secondary" size="sm" onClick={() => handleOpenChange(false)} disabled={isCreating}>
						Cancel
					</Button>
				)}
				<Button
					size="sm"
					onClick={() => void handleCreate()}
					disabled={isCreating || !name.trim() || isAtLimit}
					isLoading={isCreating}
					loadingText="Creating..."
				>
					Create
				</Button>
			</ModalFooter>
		</Modal>
	);
}
