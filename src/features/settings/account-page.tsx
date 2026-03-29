/**
 * Account Settings Page
 *
 * Active sessions management and account deletion.
 * Sessions use better-auth's listSessions/revokeSession.
 * Account deletion uses the custom API endpoints.
 */

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Monitor, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { deleteAccount, fetchAccountDeletePreview } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { formatRelativeTime } from '@/lib/utils';

import type { AccountDeletePreview } from '@/lib/api-client';

export default function AccountPage() {
	const navigate = useNavigate();

	// Fetch active sessions
	const sessionsQuery = useQuery({
		queryKey: ['sessions'],
		queryFn: async () => {
			const { data } = await authClient.listSessions();
			return data ?? [];
		},
		staleTime: 1000 * 30,
	});

	const queryClient = useQueryClient();

	const handleRevokeSession = useCallback(
		async (sessionToken: string) => {
			try {
				await authClient.revokeSession({ token: sessionToken });
				toast.success('Session revoked');
				void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			} catch {
				toast.error('Failed to revoke session');
			}
		},
		[queryClient],
	);

	const handleRevokeAllOtherSessions = useCallback(async () => {
		try {
			await authClient.revokeSessions();
			toast.success('All other sessions revoked');
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		} catch {
			toast.error('Failed to revoke sessions');
		}
	}, [queryClient]);

	// Account deletion
	const [deletePreview, setDeletePreview] = useState<AccountDeletePreview | undefined>();
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);

	const handleOpenDeleteModal = useCallback(async () => {
		setIsLoadingPreview(true);
		try {
			const preview = await fetchAccountDeletePreview();
			setDeletePreview(preview);
			setShowDeleteConfirm(true);
		} catch {
			toast.error('Failed to load account deletion details');
		} finally {
			setIsLoadingPreview(false);
		}
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		setIsDeleting(true);
		try {
			await deleteAccount();
			toast.success('Account deleted');
			void navigate('/');
		} catch {
			toast.error('Failed to delete account. You may need to resolve blocking organizations first.');
		} finally {
			setIsDeleting(false);
			setShowDeleteConfirm(false);
		}
	}, [navigate]);

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- better-auth session type is loosely typed
	const sessions = (sessionsQuery.data ?? []) as Array<{
		token: string;
		userAgent?: string;
		ipAddress?: string;
		createdAt: string | Date;
		current?: boolean;
	}>;

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h2 className="mb-1 text-lg font-semibold text-text-primary">Account</h2>
				<p className="text-sm text-text-secondary">Manage sessions and account settings.</p>
			</div>

			{/* Active Sessions */}
			<section>
				<div className="mb-3 flex items-center justify-between">
					<h3
						className="
							text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Active sessions
					</h3>
					{sessions.length > 1 && (
						<Button variant="outline" size="sm" onClick={() => void handleRevokeAllOtherSessions()}>
							Sign out all others
						</Button>
					)}
				</div>
				<div
					className="
						divide-y divide-border rounded-lg border border-border bg-bg-secondary/40
					"
				>
					{sessionsQuery.isPending ? (
						<div className="flex items-center justify-center py-8">
							<Spinner size="sm" />
						</div>
					) : sessions.length === 0 ? (
						<div className="px-4 py-6 text-center text-sm text-text-secondary">No active sessions found.</div>
					) : (
						sessions.map((session) => {
							const isMobile = session.userAgent?.includes('Mobile') ?? false;
							const Icon = isMobile ? Smartphone : Monitor;
							const createdAt = typeof session.createdAt === 'string' ? new Date(session.createdAt).getTime() : session.createdAt.getTime();
							return (
								<div key={session.token} className="flex items-center justify-between gap-3 px-4 py-3">
									<div className="flex min-w-0 items-center gap-3">
										<Icon className="size-4 shrink-0 text-text-secondary" />
										<div className="min-w-0">
											<p className="truncate text-sm text-text-primary">
												{session.userAgent?.slice(0, 60) ?? 'Unknown device'}
												{session.current && <span className="ml-1.5 text-xs font-medium text-accent">(current)</span>}
											</p>
											<p className="text-xs text-text-secondary">
												{session.ipAddress ?? 'Unknown IP'} &middot; {formatRelativeTime(createdAt)}
											</p>
										</div>
									</div>
									{!session.current && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => void handleRevokeSession(session.token)}
											className="
												shrink-0 text-xs text-text-secondary
												hover:text-error
											"
										>
											Revoke
										</Button>
									)}
								</div>
							);
						})
					)}
				</div>
			</section>

			{/* Danger Zone */}
			<section>
				<h3 className="mb-3 text-xs font-medium tracking-wider text-error/80 uppercase">Danger zone</h3>
				<div className="rounded-lg border border-error/30 bg-bg-secondary/40 px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<p className="text-sm font-medium text-text-primary">Delete account</p>
							<p className="text-xs text-text-secondary">Permanently delete your account and all single-member organizations.</p>
						</div>
						<Button
							variant="danger"
							size="sm"
							onClick={() => void handleOpenDeleteModal()}
							disabled={isLoadingPreview}
							isLoading={isLoadingPreview}
						>
							<Trash2 className="size-3.5" />
							Delete
						</Button>
					</div>
				</div>
			</section>

			{/* Delete account confirmation */}
			{deletePreview && (
				<ConfirmDialog
					open={showDeleteConfirm}
					onOpenChange={(open) => {
						if (!open && !isDeleting) setShowDeleteConfirm(false);
					}}
					title="Delete account"
					description={
						deletePreview.canDelete ? (
							<div className="flex flex-col gap-2 text-sm text-text-secondary">
								<p>This action is irreversible. Your account and all single-member organizations will be permanently deleted.</p>
								{deletePreview.singleMemberOrganizations.length > 0 && (
									<p>
										<strong className="text-text-primary">{deletePreview.singleMemberOrganizations.length} organization(s)</strong> you own
										alone will be deleted, including their projects.
									</p>
								)}
								{deletePreview.membershipOrganizations.length > 0 && (
									<p>
										You will be removed from{' '}
										<strong className="text-text-primary">{deletePreview.membershipOrganizations.length} organization(s)</strong>.
									</p>
								)}
							</div>
						) : (
							<div className="flex flex-col gap-2 text-sm text-text-secondary">
								<p>You cannot delete your account yet. You are the sole Super admin of:</p>
								<ul className="list-disc pl-4">
									{deletePreview.blockers.map((blocker) => (
										<li key={blocker.id}>
											<strong className="text-text-primary">{blocker.name}</strong> ({blocker.memberCount} members)
										</li>
									))}
								</ul>
								<p>Promote another member to Super admin or delete those organizations first.</p>
							</div>
						)
					}
					confirmLabel={deletePreview.canDelete ? 'Delete forever' : 'OK'}
					variant={deletePreview.canDelete ? 'danger' : 'default'}
					onConfirm={deletePreview.canDelete ? () => void handleConfirmDelete() : () => setShowDeleteConfirm(false)}
				/>
			)}
		</div>
	);
}
