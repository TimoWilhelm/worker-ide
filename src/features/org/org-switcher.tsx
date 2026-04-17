import { useQuery } from '@tanstack/react-query';
import { Building2, ChevronDown, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast-store';
import { fetchUserLimits } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

import { CreateOrgModal } from './create-org-modal';

interface OrgSwitcherOrganization {
	id: string;
	name: string;
	slug: string | null;
	logo?: string | null;
}

interface OrgSwitcherProperties {
	organizations: OrgSwitcherOrganization[];
	currentOrganizationId: string;
	currentOrganizationName: string;
}

export function OrgSwitcher({ organizations, currentOrganizationId, currentOrganizationName }: OrgSwitcherProperties) {
	const currentOrg = organizations.find((o) => o.id === currentOrganizationId);
	const currentOrgIdentifier = currentOrg?.slug ?? currentOrganizationId;
	const navigate = useNavigate();
	const [createModalOpen, setCreateModalOpen] = useState(false);

	// Fetch resolved user limits (defaults + entitlement overrides)
	const userLimitsQuery = useQuery({
		queryKey: ['user-limits'],
		queryFn: fetchUserLimits,
		staleTime: 1000 * 60,
	});
	const maxOrganizations = userLimitsQuery.data?.maxOrganizations;

	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger>
					<Button variant="ghost" size="sm" className="gap-2 bg-bg-secondary/40 backdrop-blur-sm">
						<Building2 className="size-4" />
						<span className="max-w-32 truncate text-xs">{currentOrganizationName}</span>
						<ChevronDown className="size-3" />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end" className="min-w-48">
					{organizations.map((organization) => (
						<DropdownMenuItem
							key={organization.id}
							onSelect={() => {
								const slug = organization.slug ?? organization.id;
								void authClient.organization.setActive({ organizationId: organization.id }).then(
									() => {
										void navigate(`/org/${slug}`);
									},
									() => {
										toast.error('Could not switch organization. Please try again.');
									},
								);
							}}
							className={cn('gap-2 text-xs', currentOrganizationId === organization.id && 'bg-bg-tertiary font-medium')}
						>
							{organization.logo ? (
								<img src={organization.logo} alt="" className="size-4 shrink-0 rounded-sm object-cover" />
							) : (
								<Building2 className="size-3.5 shrink-0 text-text-secondary" />
							)}
							<span className="truncate">{organization.name}</span>
						</DropdownMenuItem>
					))}
					<DropdownMenuSeparator />
					<DropdownMenuItem
						onSelect={() => {
							void navigate(`/org/${currentOrgIdentifier}/settings`);
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
			<CreateOrgModal
				open={createModalOpen}
				onOpenChange={setCreateModalOpen}
				organizationCount={organizations.length}
				maxOrganizations={maxOrganizations}
			/>
		</>
	);
}
