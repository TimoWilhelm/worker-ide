import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Monitor, Smartphone, Trash2 } from 'lucide-react';
import { useCallback, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button, ConfirmButton } from '@/components/ui';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { ListSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { deleteAccount, fetchAccountDeletePreview } from '@/lib/api-client';
import { authClient } from '@/lib/auth-client';
import { formatRelativeTime } from '@/lib/utils';

import type { AccountDeletePreview } from '@/lib/api-client';

interface SessionListEntry {
	token: string;
	userAgent?: string;
	ipAddress?: string;
	createdAt: string | Date;
	current?: boolean;
}

function isSessionListEntry(value: unknown): value is SessionListEntry {
	return (
		value !== null &&
		typeof value === 'object' &&
		typeof Reflect.get(value, 'token') === 'string' &&
		(typeof Reflect.get(value, 'userAgent') === 'string' || Reflect.get(value, 'userAgent') === undefined) &&
		(typeof Reflect.get(value, 'ipAddress') === 'string' || Reflect.get(value, 'ipAddress') === undefined) &&
		(Reflect.get(value, 'createdAt') instanceof Date || typeof Reflect.get(value, 'createdAt') === 'string') &&
		(typeof Reflect.get(value, 'current') === 'boolean' || Reflect.get(value, 'current') === undefined)
	);
}

export default function AccountPage() {
	const navigate = useNavigate();
	const { data: session } = authClient.useSession();

	const sessionsQuery = useQuery({
		queryKey: ['sessions'],
		queryFn: async () => {
			const { data, error } = await authClient.listSessions();
			if (error) throw new Error(error.message ?? 'Failed to load sessions');
			return data ?? [];
		},
		staleTime: 1000 * 30,
	});

	const queryClient = useQueryClient();

	const handleRevokeSession = useCallback(
		async (sessionToken: string) => {
			try {
				const { error } = await authClient.revokeSession({ token: sessionToken });
				if (error) {
					toast.error(error.message ?? 'Could not revoke this session. Please try again.');
					return;
				}
				toast.success('Session revoked');
				void queryClient.invalidateQueries({ queryKey: ['sessions'] });
			} catch {
				toast.error('Could not revoke the session. Please check your connection and try again.');
			}
		},
		[queryClient],
	);

	const handleRevokeAllOtherSessions = useCallback(async () => {
		try {
			const { error } = await authClient.revokeSessions();
			if (error) {
				toast.error(error.message ?? 'Could not revoke other sessions. Please try again.');
				return;
			}
			toast.success('All other sessions revoked');
			void queryClient.invalidateQueries({ queryKey: ['sessions'] });
		} catch {
			toast.error('Could not revoke sessions. Please check your connection and try again.');
		}
	}, [queryClient]);

	const [deletePreview, setDeletePreview] = useState<AccountDeletePreview | undefined>();
	const [isLoadingPreview, setIsLoadingPreview] = useState(false);
	const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [deleteConfirmText, setDeleteConfirmText] = useState('');
	const userEmail = session?.user.email ?? '';
	const isDeleteConfirmed = userEmail ? deleteConfirmText === userEmail : deleteConfirmText.toLowerCase() === 'delete';
	const [emailCopied, setEmailCopied] = useState(false);

	const handleOpenDeleteModal = useCallback(async () => {
		setIsLoadingPreview(true);
		try {
			const preview = await fetchAccountDeletePreview();
			setDeletePreview(preview);
			setDeleteConfirmText('');
			setShowDeleteConfirm(true);
		} catch {
			toast.error('Could not load account deletion details. Please check your connection and try again.');
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
			toast.error('Could not delete your account. You may need to transfer ownership of organizations where you are the sole Super admin.');
		} finally {
			setIsDeleting(false);
			setShowDeleteConfirm(false);
		}
	}, [navigate]);

	const sessions = Array.isArray(sessionsQuery.data) ? sessionsQuery.data.filter((session_) => isSessionListEntry(session_)) : [];

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h2 className="mb-1 text-lg font-semibold text-text-primary">Account</h2>
				<p className="text-sm text-text-secondary">Manage sessions and account settings.</p>
			</div>

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
						<ConfirmButton
							title="Sign out all sessions?"
							confirmLabel="Sign out"
							onConfirm={handleRevokeAllOtherSessions}
							variant="outline"
							size="sm"
							confirmVariant="warning"
						>
							Sign out all others
						</ConfirmButton>
					)}
				</div>
				<div
					className="
						divide-y divide-border rounded-lg border border-border bg-bg-secondary/40
					"
				>
					{sessionsQuery.isPending ? (
						<div className="p-3">
							<ListSkeleton itemCount={3} />
						</div>
					) : sessionsQuery.isError ? (
						<div className="px-4 py-6 text-center text-sm text-text-secondary">
							Could not load sessions.{' '}
							<button onClick={() => void sessionsQuery.refetch()} className="cursor-pointer text-accent underline hover:text-accent-hover">
								Retry
							</button>
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
										<ConfirmButton
											title="Revoke this session?"
											confirmLabel="Revoke"
											onConfirm={() => handleRevokeSession(session.token)}
											variant="ghost"
											size="sm"
											className="
												shrink-0 text-xs text-text-secondary
												hover:text-error
											"
										>
											Revoke
										</ConfirmButton>
									)}
								</div>
							);
						})
					)}
				</div>
			</section>

			<section>
				<h3 className="mb-3 text-xs font-medium tracking-wider text-error/80 uppercase">Danger zone</h3>
				<div className="rounded-lg border border-error/30 bg-bg-secondary/40 px-4 py-3">
					<div className="flex items-center justify-between gap-3">
						<div className="min-w-0">
							<p className="text-sm font-medium text-text-primary">Delete account</p>
							<p className="text-xs text-text-secondary">Permanently delete your account.</p>
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

			{deletePreview && (
				<Modal
					open={showDeleteConfirm}
					onOpenChange={(open) => {
						if (!open && !isDeleting) setShowDeleteConfirm(false);
					}}
					title="Delete account"
				>
					{deletePreview.canDelete ? (
						<>
							<ModalBody>
								<div className="space-y-4">
									<p className="text-sm font-medium">Are you sure you want to delete your account?</p>
									<button
										type="button"
										onClick={() => {
											void navigator.clipboard.writeText(userEmail).then(() => {
												setEmailCopied(true);
												setTimeout(() => setEmailCopied(false), 2000);
												toast.success('Copied to clipboard');
											});
										}}
										className="
											flex w-full cursor-pointer items-center gap-2 rounded-sm border
											border-border bg-bg-tertiary px-2 py-1 text-left transition-colors
											hover:bg-border/50
										"
									>
										<span
											className="
												min-w-0 flex-1 truncate text-sm font-medium text-text-primary
											"
										>
											{userEmail}
										</span>
										{emailCopied ? (
											<Check className="size-3.5 shrink-0 text-success" />
										) : (
											<Copy className="size-3.5 shrink-0 text-text-secondary" />
										)}
									</button>
									{deletePreview.singleMemberOrganizations.length > 0 && (
										<p className="text-xs text-text-secondary">
											<strong className="text-text-primary">{deletePreview.singleMemberOrganizations.length} organization(s)</strong> you
											own alone will be deleted, including their projects.
										</p>
									)}
									{deletePreview.membershipOrganizations.length > 0 && (
										<p className="text-xs text-text-secondary">
											You will lose access to{' '}
											<strong className="text-text-primary">{deletePreview.membershipOrganizations.length} organization(s)</strong>.
										</p>
									)}
									<p className="text-xs text-text-secondary">This action cannot be undone.</p>
									<div>
										<label className="mb-1.5 block text-xs text-text-secondary">Type your email to confirm</label>
										<input
											type="text"
											value={deleteConfirmText}
											onChange={(event) => setDeleteConfirmText(event.target.value)}
											onKeyDown={(event) => {
												if (event.key === 'Enter' && isDeleteConfirmed && !isDeleting) {
													void handleConfirmDelete();
												}
											}}
											disabled={isDeleting}
											autoComplete="off"
											className="
												h-8 w-full rounded-md border border-border bg-bg-secondary/60 px-2
												text-sm text-text-primary transition-colors
												placeholder:text-text-secondary/50
												focus-within:border-accent
												focus:outline-none
											"
										/>
									</div>
								</div>
							</ModalBody>
							<ModalFooter>
								<Button variant="secondary" size="sm" onClick={() => setShowDeleteConfirm(false)} disabled={isDeleting}>
									Cancel
								</Button>
								<Button
									size="sm"
									variant="danger"
									onClick={() => void handleConfirmDelete()}
									disabled={isDeleting || !isDeleteConfirmed}
									isLoading={isDeleting}
								>
									Delete
								</Button>
							</ModalFooter>
						</>
					) : (
						<>
							<ModalBody>
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
							</ModalBody>
							<ModalFooter>
								<Button variant="secondary" size="sm" onClick={() => setShowDeleteConfirm(false)}>
									OK
								</Button>
							</ModalFooter>
						</>
					)}
				</Modal>
			)}
		</div>
	);
}
