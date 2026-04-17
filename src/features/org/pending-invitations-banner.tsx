import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Mail, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

interface UserInvitation {
	id: string;
	organizationName: string;
	organizationId: string;
	role?: string | undefined;
	status: string;
}

function isUserInvitation(value: unknown): value is UserInvitation {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof Reflect.get(value, 'id') === 'string' &&
		typeof Reflect.get(value, 'organizationName') === 'string' &&
		typeof Reflect.get(value, 'organizationId') === 'string' &&
		(typeof Reflect.get(value, 'role') === 'string' || Reflect.get(value, 'role') === undefined) &&
		typeof Reflect.get(value, 'status') === 'string'
	);
}

export function PendingInvitationsBanner() {
	const [actingOn, setActingOn] = useState<string | undefined>();
	const queryClient = useQueryClient();

	const invitationsQuery = useQuery({
		queryKey: ['user-invitations'],
		queryFn: async () => {
			const { data, error } = await authClient.organization.listUserInvitations();
			if (error) throw new Error(error.message ?? 'Failed to load invitations');
			if (!Array.isArray(data)) return [];
			return data.filter((invitation) => isUserInvitation(invitation)).filter((invitation) => invitation.status === 'pending');
		},
		staleTime: 1000 * 30,
	});
	const invitations = invitationsQuery.data ?? [];

	const handleAccept = useCallback(
		async (invitationId: string) => {
			setActingOn(invitationId);
			try {
				const { error } = await authClient.organization.acceptInvitation({
					invitationId,
				});
				if (error) {
					toast.error(error.message ?? 'Failed to accept invitation');
					return;
				}
				toast.success('Invitation accepted');
				void queryClient.invalidateQueries({ queryKey: ['user-invitations'] });
			} catch {
				toast.error('Failed to accept invitation');
			} finally {
				setActingOn(undefined);
			}
		},
		[queryClient],
	);

	const handleReject = useCallback(
		async (invitationId: string) => {
			setActingOn(invitationId);
			try {
				const { error } = await authClient.organization.rejectInvitation({
					invitationId,
				});
				if (error) {
					toast.error(error.message ?? 'Failed to reject invitation');
					return;
				}
				toast.success('Invitation declined');
				void queryClient.invalidateQueries({ queryKey: ['user-invitations'] });
			} catch {
				toast.error('Failed to reject invitation');
			} finally {
				setActingOn(undefined);
			}
		},
		[queryClient],
	);

	if (invitations.length === 0) return;

	return (
		<section className="mb-8">
			<h2
				className="
					mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
				"
			>
				Pending invitations
			</h2>
			<div
				className={cn(
					`
						overflow-hidden rounded-lg border border-accent/30 bg-bg-secondary/40
						backdrop-blur-sm
					`,
					'divide-y divide-border',
				)}
			>
				{invitations.map((invitation) => {
					const isActing = actingOn === invitation.id;
					return (
						<div key={invitation.id} className="flex items-center justify-between gap-3 px-4 py-3">
							<div className="flex min-w-0 items-center gap-3">
								<div
									className="
										flex size-8 shrink-0 items-center justify-center rounded-full
										bg-accent/10 text-accent
									"
								>
									<Mail className="size-3.5" />
								</div>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-text-primary">{invitation.organizationName}</p>
									<p className="text-xs text-text-secondary">Invited as {invitation.role ?? 'member'}</p>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<button
									onClick={() => void handleAccept(invitation.id)}
									disabled={isActing}
									title="Accept invitation"
									className="
										cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
										hover:bg-bg-tertiary hover:text-green-500
										disabled:pointer-events-none disabled:opacity-50
									"
								>
									<Check className="size-3.5" />
								</button>
								<button
									onClick={() => void handleReject(invitation.id)}
									disabled={isActing}
									title="Decline invitation"
									className="
										cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
										hover:bg-bg-tertiary hover:text-error
										disabled:pointer-events-none disabled:opacity-50
									"
								>
									<X className="size-3.5" />
								</button>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}
