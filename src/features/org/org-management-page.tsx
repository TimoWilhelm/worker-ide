/**
 * Organization Management Page
 *
 * Minimal page for managing org members: invite, remove,
 * transfer ownership, leave, rename org, delete org, and
 * promote/demote member roles. Uses better-auth's organization
 * client methods — no custom backend routes needed.
 */

import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, ChevronDown, ChevronUp, Crown, Mail, Pencil, Shield, Trash2, User, UserPlus, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { fetchOrgProjects } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';
import { MAX_MEMBERS_PER_ORGANIZATION, MAX_ORGANIZATION_NAME_LENGTH, MAX_PENDING_INVITATIONS_PER_ORGANIZATION } from '@shared/constants';

// =============================================================================
// Types
// =============================================================================

interface OrgMember {
	id: string;
	userId: string;
	role: string;
	user: { name: string; email: string; image?: string | undefined };
}

interface OrgInvitation {
	id: string;
	email: string;
	role?: string | undefined;
	status: string;
}

type ConfirmAction =
	| { type: 'remove'; member: OrgMember }
	| { type: 'transfer'; member: OrgMember }
	| { type: 'promote'; member: OrgMember; targetRole: string }
	| { type: 'demote'; member: OrgMember; targetRole: string }
	| { type: 'leave' }
	| { type: 'delete-org' };

// =============================================================================
// Role helpers
// =============================================================================

const ROLE_CONFIG: Record<string, { label: string; icon: typeof Crown; className: string }> = {
	owner: { label: 'Owner', icon: Crown, className: 'bg-warning/15 text-warning' },
	admin: { label: 'Admin', icon: Shield, className: 'bg-accent/15 text-accent' },
	member: { label: 'Member', icon: User, className: 'bg-bg-tertiary text-text-secondary' },
};

function RoleBadge({ role }: { role: string }) {
	const config = ROLE_CONFIG[role] ?? ROLE_CONFIG.member;
	const Icon = config.icon;
	return (
		<span className={cn('inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs font-medium', config.className)}>
			<Icon className="size-3" />
			{config.label}
		</span>
	);
}

// =============================================================================
// Member Row
// =============================================================================

function MemberRow({
	member,
	currentUserId,
	isOwner,
	onRemove,
	onTransferOwnership,
	onChangeRole,
}: {
	member: OrgMember;
	currentUserId: string;
	isOwner: boolean;
	onRemove: (member: OrgMember) => void;
	onTransferOwnership: (member: OrgMember) => void;
	onChangeRole: (member: OrgMember, targetRole: string, direction: 'promote' | 'demote') => void;
}) {
	const isSelf = member.userId === currentUserId;
	const canRemove = isOwner && !isSelf && member.role !== 'owner';
	const canTransfer = isOwner && !isSelf && member.role !== 'owner';
	const canPromote = isOwner && !isSelf && member.role === 'member';
	const canDemote = isOwner && !isSelf && member.role === 'admin';

	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<div
					className="
						flex size-8 shrink-0 items-center justify-center rounded-full
						bg-bg-tertiary text-xs font-medium text-text-secondary
					"
				>
					{member.user.name.charAt(0).toUpperCase()}
				</div>
				<div className="min-w-0">
					<p className="truncate text-sm font-medium text-text-primary">
						{member.user.name}
						{isSelf && <span className="ml-1 text-xs font-normal text-text-secondary">(you)</span>}
					</p>
					<p className="truncate text-xs text-text-secondary">{member.user.email}</p>
				</div>
			</div>
			<div className="flex shrink-0 items-center gap-2">
				<RoleBadge role={member.role} />
				{canPromote && (
					<button
						onClick={() => onChangeRole(member, 'admin', 'promote')}
						title="Promote to admin"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-accent
						"
					>
						<ChevronUp className="size-3.5" />
					</button>
				)}
				{canDemote && (
					<button
						onClick={() => onChangeRole(member, 'member', 'demote')}
						title="Demote to member"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						"
					>
						<ChevronDown className="size-3.5" />
					</button>
				)}
				{canTransfer && (
					<button
						onClick={() => onTransferOwnership(member)}
						title="Transfer ownership"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-warning
						"
					>
						<Crown className="size-3.5" />
					</button>
				)}
				{canRemove && (
					<button
						onClick={() => onRemove(member)}
						title="Remove member"
						className="
							cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-error
						"
					>
						<Trash2 className="size-3.5" />
					</button>
				)}
			</div>
		</div>
	);
}

// =============================================================================
// Invitation Row
// =============================================================================

function InvitationRow({
	invitation,
	canCancel,
	onCancel,
}: {
	invitation: OrgInvitation;
	canCancel: boolean;
	onCancel: (invitationId: string) => void;
}) {
	return (
		<div className="flex items-center justify-between gap-3 px-4 py-3">
			<div className="flex min-w-0 items-center gap-3">
				<div
					className="
						flex size-8 shrink-0 items-center justify-center rounded-full
						bg-bg-tertiary text-text-secondary
					"
				>
					<Mail className="size-3.5" />
				</div>
				<div className="min-w-0">
					<p className="truncate text-sm text-text-primary">{invitation.email}</p>
					<p className="text-xs text-text-secondary">Pending &middot; {invitation.role ?? 'member'}</p>
				</div>
			</div>
			{canCancel && (
				<button
					onClick={() => onCancel(invitation.id)}
					title="Cancel invitation"
					className="
						shrink-0 cursor-pointer rounded-md p-1.5 text-text-secondary
						transition-colors
						hover:bg-bg-tertiary hover:text-error
					"
				>
					<X className="size-3.5" />
				</button>
			)}
		</div>
	);
}

// =============================================================================
// Invite Form
// =============================================================================

function InviteForm({
	organizationId,
	memberCount,
	pendingInvitationCount,
	onInvited,
}: {
	organizationId: string;
	memberCount: number;
	pendingInvitationCount: number;
	onInvited: () => void;
}) {
	const [email, setEmail] = useState('');
	const [role, setRole] = useState<'member' | 'admin'>('member');
	const [isSending, setIsSending] = useState(false);

	const memberLimitReached = memberCount >= MAX_MEMBERS_PER_ORGANIZATION;
	const invitationLimitReached = pendingInvitationCount >= MAX_PENDING_INVITATIONS_PER_ORGANIZATION;
	const isLimitReached = memberLimitReached || invitationLimitReached;

	const handleInvite = useCallback(async () => {
		const trimmed = email.trim();
		if (!trimmed) return;

		setIsSending(true);
		try {
			const { error } = await authClient.organization.inviteMember({
				email: trimmed,
				role,
				organizationId,
			});
			if (error) {
				toast.error(error.message ?? 'Failed to send invitation');
				return;
			}
			toast.success(`Invitation sent to ${trimmed}`);
			setEmail('');
			onInvited();
		} catch {
			toast.error('Failed to send invitation');
		} finally {
			setIsSending(false);
		}
	}, [email, role, organizationId, onInvited]);

	return (
		<div className="px-4 py-3">
			<label className="mb-1.5 block text-xs font-medium text-text-secondary">Email address</label>
			<div className="flex items-center gap-2">
				<div className="relative min-w-0 flex-1">
					<UserPlus
						className="
							pointer-events-none absolute top-1/2 left-3 z-10 size-3.5
							-translate-y-1/2 text-text-secondary
						"
					/>
					<input
						type="email"
						value={email}
						onChange={(event) => setEmail(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && email.trim() && !isLimitReached) {
								void handleInvite();
							}
						}}
						placeholder={isLimitReached ? 'Limit reached' : 'teammate@example.com'}
						disabled={isSending || isLimitReached}
						className="
							h-9 w-full rounded-md border border-border bg-bg-secondary/60 pr-3 pl-9
							text-xs text-text-primary backdrop-blur-sm transition-colors
							placeholder:text-text-secondary/50
							focus-within:border-accent
							focus:outline-none
						"
					/>
				</div>
				<select
					value={role}
					onChange={(event) => {
						const value = event.target.value;
						if (value === 'member' || value === 'admin') {
							setRole(value);
						}
					}}
					disabled={isSending || isLimitReached}
					className="
						h-9 shrink-0 rounded-md border border-border bg-bg-secondary/60 pr-8 pl-3
						text-xs text-text-primary backdrop-blur-sm transition-colors
						focus:outline-none
					"
				>
					<option value="member">Member</option>
					<option value="admin">Admin</option>
				</select>
				<Button
					size="sm"
					className="h-9 shrink-0"
					onClick={() => void handleInvite()}
					disabled={isSending || !email.trim() || isLimitReached}
					isLoading={isSending}
					loadingText="Sending..."
				>
					Invite
				</Button>
			</div>
			{isLimitReached && (
				<p className="mt-2 text-xs text-text-secondary/80">
					{memberLimitReached
						? `Member limit reached (${MAX_MEMBERS_PER_ORGANIZATION}).`
						: `Pending invitation limit reached (${MAX_PENDING_INVITATIONS_PER_ORGANIZATION}).`}
				</p>
			)}
		</div>
	);
}

// =============================================================================
// Main Page Component
// =============================================================================

export default function OrgManagementPage() {
	const { data: session } = authClient.useSession();
	const { data: activeOrganization, isPending } = authClient.useActiveOrganization();

	const [confirmAction, setConfirmAction] = useState<ConfirmAction | undefined>();
	const [isActing, setIsActing] = useState(false);

	// Rename state
	const [isEditingName, setIsEditingName] = useState(false);
	const [editName, setEditName] = useState('');
	const [isRenaming, setIsRenaming] = useState(false);

	const currentUserId = session?.user.id;
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth returns loosely typed members/invitations
	const members = (activeOrganization?.members ?? []) as unknown as OrgMember[];
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth returns loosely typed members/invitations
	const invitations = (activeOrganization?.invitations ?? []) as unknown as OrgInvitation[];
	const pendingInvitations = invitations.filter((invitation) => invitation.status === 'pending');

	const currentMember = members.find((member) => member.userId === currentUserId);
	const isOwner = currentMember?.role === 'owner';
	const isAdminOrOwner = isOwner || currentMember?.role === 'admin';

	// Fetch org projects to gate delete-org
	const projectsQuery = useQuery({
		queryKey: ['org-projects'],
		queryFn: fetchOrgProjects,
		staleTime: 1000 * 30,
	});
	const hasActiveProjects = (projectsQuery.data ?? []).length > 0;

	const refreshOrganization = useCallback(() => {
		void authClient.organization.setActive({
			organizationId: activeOrganization?.id ?? '',
		});
	}, [activeOrganization?.id]);

	// --- Rename ---
	const handleStartRename = useCallback(() => {
		setEditName(activeOrganization?.name ?? '');
		setIsEditingName(true);
	}, [activeOrganization?.name]);

	const handleRename = useCallback(async () => {
		const trimmed = editName.trim();
		if (!trimmed || trimmed === activeOrganization?.name) {
			setIsEditingName(false);
			return;
		}
		if (trimmed.length > MAX_ORGANIZATION_NAME_LENGTH) {
			toast.error(`Name must be ${MAX_ORGANIZATION_NAME_LENGTH} characters or fewer.`);
			return;
		}
		setIsRenaming(true);
		try {
			const { error } = await authClient.organization.update({
				data: { name: trimmed },
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to rename organization');
				return;
			}
			toast.success('Organization renamed');
			refreshOrganization();
		} catch {
			toast.error('Failed to rename organization');
		} finally {
			setIsRenaming(false);
			setIsEditingName(false);
		}
	}, [editName, activeOrganization?.name, activeOrganization?.id, refreshOrganization]);

	// --- Remove member ---
	const handleRemoveMember = useCallback(async () => {
		if (confirmAction?.type !== 'remove') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.removeMember({
				memberIdOrEmail: confirmAction.member.id,
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to remove member');
				return;
			}
			toast.success(`${confirmAction.member.user.name} removed`);
			refreshOrganization();
		} catch {
			toast.error('Failed to remove member');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	}, [confirmAction, activeOrganization?.id, refreshOrganization]);

	// --- Transfer ownership ---
	const handleTransferOwnership = useCallback(async () => {
		if (confirmAction?.type !== 'transfer') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.updateMemberRole({
				memberId: confirmAction.member.id,
				role: 'owner',
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to transfer ownership');
				return;
			}
			toast.success(`Ownership transferred to ${confirmAction.member.user.name}`);
			refreshOrganization();
		} catch {
			toast.error('Failed to transfer ownership');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	}, [confirmAction, activeOrganization?.id, refreshOrganization]);

	// --- Promote / Demote ---
	const handleChangeRole = useCallback(async () => {
		if (confirmAction?.type !== 'promote' && confirmAction?.type !== 'demote') return;
		setIsActing(true);
		try {
			const { error } = await authClient.organization.updateMemberRole({
				memberId: confirmAction.member.id,
				role: confirmAction.targetRole,
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to change role');
				return;
			}
			const verb = confirmAction.type === 'promote' ? 'promoted' : 'demoted';
			toast.success(`${confirmAction.member.user.name} ${verb} to ${confirmAction.targetRole}`);
			refreshOrganization();
		} catch {
			toast.error('Failed to change role');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	}, [confirmAction, activeOrganization?.id, refreshOrganization]);

	// --- Leave ---
	const handleLeave = useCallback(async () => {
		setIsActing(true);
		try {
			const { error } = await authClient.organization.leave({
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to leave organization');
				return;
			}
			toast.success('You left the organization');
			globalThis.location.href = '/';
		} catch {
			toast.error('Failed to leave organization');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	}, [activeOrganization?.id]);

	// --- Delete org ---
	const handleDeleteOrg = useCallback(async () => {
		setIsActing(true);
		try {
			const { error } = await authClient.organization.delete({
				organizationId: activeOrganization?.id ?? '',
			});
			if (error) {
				toast.error(error.message ?? 'Failed to delete organization');
				return;
			}
			toast.success('Organization deleted');
			globalThis.location.href = '/';
		} catch {
			toast.error('Failed to delete organization');
		} finally {
			setIsActing(false);
			setConfirmAction(undefined);
		}
	}, [activeOrganization?.id]);

	// --- Cancel invitation ---
	const handleCancelInvitation = useCallback(
		async (invitationId: string) => {
			try {
				const { error } = await authClient.organization.cancelInvitation({
					invitationId,
				});
				if (error) {
					toast.error(error.message ?? 'Failed to cancel invitation');
					return;
				}
				toast.success('Invitation cancelled');
				refreshOrganization();
			} catch {
				toast.error('Failed to cancel invitation');
			}
		},
		[refreshOrganization],
	);

	// --- Confirm dispatch ---
	const handleConfirm = useCallback(() => {
		if (confirmAction?.type === 'remove') void handleRemoveMember();
		if (confirmAction?.type === 'transfer') void handleTransferOwnership();
		if (confirmAction?.type === 'promote' || confirmAction?.type === 'demote') void handleChangeRole();
		if (confirmAction?.type === 'leave') void handleLeave();
		if (confirmAction?.type === 'delete-org') void handleDeleteOrg();
	}, [confirmAction, handleRemoveMember, handleTransferOwnership, handleChangeRole, handleLeave, handleDeleteOrg]);

	if (isPending) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg-primary">
				<Spinner size="lg" />
			</div>
		);
	}

	if (!activeOrganization) {
		return (
			<div className="flex h-dvh items-center justify-center bg-bg-primary">
				<p className="text-text-secondary">No active organization</p>
			</div>
		);
	}

	const confirmDialogProperties = getConfirmDialogProperties(confirmAction, activeOrganization.name);

	return (
		<div className="flex h-dvh flex-col items-center overflow-y-auto bg-bg-primary">
			{/* Confirm dialog */}
			{confirmDialogProperties && (
				<ConfirmDialog
					open={confirmAction !== undefined}
					onOpenChange={(open) => {
						if (!open && !isActing) setConfirmAction(undefined);
					}}
					title={confirmDialogProperties.title}
					description={confirmDialogProperties.description}
					confirmLabel={confirmDialogProperties.confirmLabel}
					variant={confirmDialogProperties.variant}
					onConfirm={handleConfirm}
				/>
			)}

			<main className="w-full max-w-lg px-6 py-12">
				{/* Header */}
				<div className="mb-8 flex items-center gap-3">
					<a
						href="/"
						className="
							rounded-md p-1.5 text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						"
						aria-label="Back to dashboard"
					>
						<ArrowLeft className="size-4" />
					</a>
					<div className="min-w-0 flex-1">
						{isEditingName ? (
							<div className="flex items-center gap-2">
								<input
									type="text"
									value={editName}
									onChange={(event) => setEditName(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === 'Enter') void handleRename();
										if (event.key === 'Escape') setIsEditingName(false);
									}}
									maxLength={MAX_ORGANIZATION_NAME_LENGTH}
									disabled={isRenaming}
									autoFocus
									className="
										h-8 min-w-0 flex-1 rounded-md border border-border bg-bg-secondary/60
										px-2 text-sm font-semibold text-text-primary transition-colors
										focus-within:border-accent
										focus:outline-none
									"
								/>
								<Button size="sm" className="h-8 shrink-0" onClick={() => void handleRename()} disabled={isRenaming} isLoading={isRenaming}>
									Save
								</Button>
								<Button variant="ghost" size="sm" className="h-8 shrink-0" onClick={() => setIsEditingName(false)} disabled={isRenaming}>
									Cancel
								</Button>
							</div>
						) : (
							<div className="flex items-center gap-2">
								<h1 className="truncate text-lg font-semibold text-text-primary">{activeOrganization.name}</h1>
								{isOwner && (
									<button
										onClick={handleStartRename}
										title="Rename organization"
										className="
											cursor-pointer rounded-md p-1 text-text-secondary transition-colors
											hover:bg-bg-tertiary hover:text-text-primary
										"
									>
										<Pencil className="size-3.5" />
									</button>
								)}
							</div>
						)}
						<p className="text-xs text-text-secondary">Organization settings</p>
						<p className="mt-0.5 font-mono text-xs text-text-secondary/50">{activeOrganization.id}</p>
					</div>
					{!isOwner && (
						<Button variant="outline" size="sm" onClick={() => setConfirmAction({ type: 'leave' })}>
							Leave
						</Button>
					)}
				</div>

				{/* Members */}
				<section className="mb-6">
					<h2
						className="
							mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Members ({members.length}/{MAX_MEMBERS_PER_ORGANIZATION})
					</h2>
					<div className={cn('overflow-hidden rounded-lg border border-border bg-bg-secondary/40', 'divide-y divide-border')}>
						{members.map((member) => (
							<MemberRow
								key={member.id}
								member={member}
								currentUserId={currentUserId ?? ''}
								isOwner={isOwner}
								onRemove={(m) => setConfirmAction({ type: 'remove', member: m })}
								onTransferOwnership={(m) => setConfirmAction({ type: 'transfer', member: m })}
								onChangeRole={(m, targetRole, direction) => setConfirmAction({ type: direction, member: m, targetRole })}
							/>
						))}
					</div>
				</section>

				{/* Invite */}
				{isAdminOrOwner && (
					<section className="mb-6">
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Invite member
						</h2>
						<div className="rounded-lg border border-border bg-bg-secondary/40">
							<InviteForm
								organizationId={activeOrganization.id}
								memberCount={members.length}
								pendingInvitationCount={pendingInvitations.length}
								onInvited={refreshOrganization}
							/>
						</div>
					</section>
				)}

				{/* Pending Invitations */}
				{pendingInvitations.length > 0 && (
					<section className="mb-6">
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Pending invitations ({pendingInvitations.length})
						</h2>
						<div
							className={cn(
								`
									divide-y divide-border overflow-hidden rounded-lg border border-border
									bg-bg-secondary/40
								`,
							)}
						>
							{pendingInvitations.map((invitation) => (
								<InvitationRow
									key={invitation.id}
									invitation={invitation}
									canCancel={isAdminOrOwner}
									onCancel={(id) => void handleCancelInvitation(id)}
								/>
							))}
						</div>
					</section>
				)}

				{/* Danger Zone — Delete Organization */}
				{isOwner && (
					<section>
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-error/80 uppercase
							"
						>
							Danger zone
						</h2>
						<div
							className="
								rounded-lg border border-error/30 bg-bg-secondary/40 px-4 py-3
							"
						>
							<div className="flex items-center justify-between gap-3">
								<div className="min-w-0">
									<p className="text-sm font-medium text-text-primary">Delete organization</p>
									<p className="text-xs text-text-secondary">
										{hasActiveProjects
											? 'Delete all projects first before deleting the organization.'
											: 'Permanently delete this organization and all its data.'}
									</p>
								</div>
								<Button variant="danger" size="sm" disabled={hasActiveProjects} onClick={() => setConfirmAction({ type: 'delete-org' })}>
									Delete
								</Button>
							</div>
						</div>
					</section>
				)}
			</main>
		</div>
	);
}

// =============================================================================
// Confirm Dialog Properties Helper
// =============================================================================

function getConfirmDialogProperties(
	confirmAction: ConfirmAction | undefined,
	organizationName: string,
): { title: string; description: React.ReactNode; confirmLabel: string; variant: 'danger' | 'warning' | 'default' } | undefined {
	if (!confirmAction) return undefined;

	switch (confirmAction.type) {
		case 'remove': {
			return {
				title: 'Remove member',
				description: (
					<>
						Are you sure you want to remove <strong className="text-text-primary">{confirmAction.member.user.name}</strong> from this
						organization?
					</>
				),
				confirmLabel: 'Remove',
				variant: 'danger',
			};
		}
		case 'transfer': {
			return {
				title: 'Transfer ownership',
				description: (
					<>
						Transfer ownership to <strong className="text-text-primary">{confirmAction.member.user.name}</strong>? You will be demoted to
						admin.
					</>
				),
				confirmLabel: 'Transfer',
				variant: 'warning',
			};
		}
		case 'promote': {
			return {
				title: 'Promote member',
				description: (
					<>
						Promote <strong className="text-text-primary">{confirmAction.member.user.name}</strong> to{' '}
						<strong className="text-text-primary">{confirmAction.targetRole}</strong>?
					</>
				),
				confirmLabel: 'Promote',
				variant: 'default',
			};
		}
		case 'demote': {
			return {
				title: 'Demote member',
				description: (
					<>
						Demote <strong className="text-text-primary">{confirmAction.member.user.name}</strong> to{' '}
						<strong className="text-text-primary">{confirmAction.targetRole}</strong>?
					</>
				),
				confirmLabel: 'Demote',
				variant: 'warning',
			};
		}
		case 'leave': {
			return {
				title: 'Leave organization',
				description: (
					<>
						Are you sure you want to leave <strong className="text-text-primary">{organizationName}</strong>? You will lose access to all
						projects in this organization.
					</>
				),
				confirmLabel: 'Leave',
				variant: 'danger',
			};
		}
		case 'delete-org': {
			return {
				title: 'Delete organization',
				description: (
					<>
						Permanently delete <strong className="text-text-primary">{organizationName}</strong>? This action cannot be undone.
					</>
				),
				confirmLabel: 'Delete forever',
				variant: 'danger',
			};
		}
	}
}
