/**
 * Organization Switcher
 *
 * Dropdown to switch between organizations the user belongs to.
 * Shown in the dashboard header. Uses the accessible DropdownMenu
 * primitive for keyboard navigation, ARIA attributes, and focus management.
 */

import { Building2, ChevronDown, Plus, Settings } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

import { CreateOrgModal } from './create-org-modal';

export function OrgSwitcher() {
	const { data: organizations, isPending } = authClient.useListOrganizations();
	const { data: activeOrganization } = authClient.useActiveOrganization();
	const [createModalOpen, setCreateModalOpen] = useState(false);

	const handleSwitchOrg = useCallback(
		(organizationId: string) => {
			if (organizationId === activeOrganization?.id) return;
			void authClient.organization.setActive({ organizationId }).then(() => {
				globalThis.location.reload();
			});
		},
		[activeOrganization?.id],
	);

	if (isPending) return <></>;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="sm" className="gap-2 bg-bg-secondary/40 backdrop-blur-sm">
						<Building2 className="size-4" />
						<span className="max-w-32 truncate text-xs">{activeOrganization?.name}</span>
						<ChevronDown className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-48">
					{organizations?.map((organization) => (
						<DropdownMenuItem
							key={organization.id}
							onSelect={() => handleSwitchOrg(organization.id)}
							className={cn('gap-2 text-xs', activeOrganization?.id === organization.id && 'bg-bg-tertiary font-medium')}
						>
							<Building2 className="size-3.5 shrink-0 text-text-secondary" />
							<span className="truncate">{organization.name}</span>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => {
							globalThis.location.href = '/org';
						}}
						className="gap-2 text-xs text-text-secondary"
					>
						<Settings className="size-3.5 shrink-0" />
						<span>Manage organization</span>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={() => setCreateModalOpen(true)} className="gap-2 text-xs text-text-secondary">
						<Plus className="size-3.5 shrink-0" />
						<span>New organization</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			<CreateOrgModal open={createModalOpen} onOpenChange={setCreateModalOpen} organizationCount={organizations?.length ?? 0} />
		</>
	);
}
