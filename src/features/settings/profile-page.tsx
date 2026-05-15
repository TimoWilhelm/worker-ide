import { Check, Github, Link, Pencil, Unlink } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { Button } from '@/components/ui/button';
import { InlineRenameField } from '@/components/ui/inline-rename-field';
import { ListSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { selectOptimisticUserName, useStore } from '@/lib/store';

interface ProfilePageProperties {
	user: { name: string; email: string; image?: string; emailVerified?: boolean };
}

export default function ProfilePage({ user }: ProfilePageProperties) {
	const [isEditingName, setIsEditingName] = useState(false);
	const [isRenaming, setIsRenaming] = useState(false);

	const { refetch: refetchSession } = authClient.useSession();
	const optimisticUserName = useStore(selectOptimisticUserName);
	const setOptimisticUserName = useStore((state) => state.setOptimisticUserName);

	const initials = user.name
		.split(' ')
		.map((part) => part.charAt(0))
		.join('')
		.toUpperCase()
		.slice(0, 2);

	const handleStartEditName = useCallback(() => {
		setIsEditingName(true);
	}, []);

	const handleCancelEditName = useCallback(() => {
		setIsEditingName(false);
	}, []);

	const handleSaveName = useCallback(
		async (value: string) => {
			if (isRenaming) {
				return;
			}

			const trimmed = value.trim();
			setIsEditingName(false);

			if (!trimmed || trimmed === user.name) {
				return;
			}

			const previousOptimisticUserName = optimisticUserName;
			setIsRenaming(true);
			setOptimisticUserName(trimmed);

			try {
				const { error } = await authClient.updateUser({ name: trimmed });
				if (error) {
					setOptimisticUserName(previousOptimisticUserName);
					toast.error(error.message ?? 'Failed to update your display name. Please try again.');
					return;
				}
				void refetchSession();
				toast.success('Name updated');
			} catch {
				setOptimisticUserName(previousOptimisticUserName);
				toast.error('Failed to update name. Please check your connection and try again.');
			} finally {
				setIsRenaming(false);
			}
		},
		[isRenaming, optimisticUserName, refetchSession, setOptimisticUserName, user.name],
	);

	return (
		<div className="flex flex-col gap-8">
			<div>
				<h2 className="mb-1 text-lg font-semibold text-text-primary">Profile</h2>
				<p className="text-sm text-text-secondary">Manage your personal information.</p>
			</div>

			<section
				className="
					flex flex-col gap-5 rounded-lg border border-border bg-bg-secondary/40 p-4
				"
			>
				<div className="flex items-center gap-4">
					{user.image ? (
						<img src={user.image} alt={user.name} className="size-16 rounded-full border border-border object-cover" />
					) : (
						<div
							className="
								flex size-16 items-center justify-center rounded-full bg-bg-tertiary
								text-lg font-medium text-text-secondary
							"
						>
							{initials}
						</div>
					)}
				</div>

				<div>
					<label
						className="
							mb-2 block text-xs font-medium tracking-wider text-text-secondary
							uppercase
						"
					>
						Display name
					</label>
					<InlineRenameField
						isEditing={isEditingName}
						displayValue={user.name}
						inputValue={user.name}
						onStartEditing={handleStartEditName}
						onSubmit={handleSaveName}
						onCancel={handleCancelEditName}
						inputAriaLabel="Edit display name"
						maxLength={50}
						className="min-h-9 w-full"
						inputClassName="
							h-9 rounded-md border border-accent bg-bg-secondary/60 px-3 text-sm
							text-text-primary
							focus:outline-none
						"
					>
						{({ displayValue, startEditing }) => (
							<div className="flex w-full items-center gap-2">
								<span className="text-sm text-text-primary">{displayValue}</span>
								<button
									onClick={startEditing}
									className="
										cursor-pointer rounded-md p-1 text-text-secondary transition-colors
										hover:text-text-primary
									"
									aria-label="Edit display name"
								>
									<Pencil className="size-3.5" />
								</button>
							</div>
						)}
					</InlineRenameField>
				</div>

				<div>
					<label
						className="
							mb-2 block text-xs font-medium tracking-wider text-text-secondary
							uppercase
						"
					>
						Email
					</label>
					<div className="flex items-center gap-2">
						<span className="text-sm text-text-primary">{user.email}</span>
						{user.emailVerified !== false && (
							<span
								className="
									inline-flex items-center gap-1 rounded-md bg-green-500/10 px-1.5 py-0.5
									text-xs text-green-600
								"
							>
								<Check className="size-3" />
								Verified
							</span>
						)}
					</div>
				</div>
			</section>

			<LinkedAccountsSection />
		</div>
	);
}

interface LinkedAccount {
	providerId: string;
	accountId: string;
}

const SUPPORTED_PROVIDERS: Array<{
	id: string;
	name: string;
	icon: React.ComponentType<{ className?: string }>;
}> = [
	{ id: 'github', name: 'GitHub', icon: Github },
	{ id: 'google', name: 'Google', icon: GoogleIcon },
];

function GoogleIcon({ className }: { className?: string }) {
	return (
		<svg className={className} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
			<path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" />
			<path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
			<path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" />
			<path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" />
		</svg>
	);
}

function LinkedAccountsSection() {
	const [accounts, setAccounts] = useState<LinkedAccount[]>([]);
	const [isLoading, setIsLoading] = useState(true);
	const [loadError, setLoadError] = useState(false);
	const [actingProvider, setActingProvider] = useState<string | undefined>();

	const fetchAccounts = async (signal?: AbortSignal) => {
		setLoadError(false);
		try {
			const { data, error } = await authClient.listAccounts();
			if (signal?.aborted) return;
			if (error) {
				setLoadError(true);
				return;
			}
			if (data) {
				const mapped: LinkedAccount[] = (Array.isArray(data) ? data : []).map((entry) => ({
					providerId: String(('providerId' in entry && entry.providerId) || ''),
					accountId: String(('accountId' in entry && entry.accountId) || ''),
				}));
				setAccounts(mapped);
			}
		} catch {
			if (signal?.aborted) return;
			setLoadError(true);
		} finally {
			if (!signal?.aborted) {
				setIsLoading(false);
			}
		}
	};

	useEffect(() => {
		const controller = new AbortController();
		void Promise.resolve().then(() => fetchAccounts(controller.signal));
		return () => controller.abort();
	}, []);

	const handleLink = async (providerId: string) => {
		const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId;
		setActingProvider(providerId);
		try {
			const { error } = await authClient.linkSocial({
				provider: providerId,
				callbackURL: '/settings/profile',
			});
			if (error) {
				toast.error(error.message ?? `Could not start linking ${providerName}. Please try again.`);
			}
		} catch {
			toast.error(`Could not connect to ${providerName}. Please check your connection and try again.`);
		} finally {
			setActingProvider(undefined);
		}
	};

	const handleUnlink = async (providerId: string) => {
		const providerName = SUPPORTED_PROVIDERS.find((p) => p.id === providerId)?.name ?? providerId;
		setActingProvider(providerId);
		try {
			const { error } = await authClient.unlinkAccount({ providerId });
			if (error) {
				const message =
					error.code === 'CANT_UNLINK_LAST_ACCOUNT'
						? `Cannot unlink ${providerName} because it is your only sign-in method. Link another account first.`
						: (error.message ?? `Failed to unlink ${providerName}. Please try again.`);
				toast.error(message);
			} else {
				toast.success(`${providerName} account unlinked`);
				void fetchAccounts();
			}
		} catch {
			toast.error(`Could not unlink ${providerName}. Please check your connection and try again.`);
		} finally {
			setActingProvider(undefined);
		}
	};

	const linkedProviderIds = new Set(accounts.map((account) => account.providerId));
	const canUnlink = accounts.length > 1;

	return (
		<section className="rounded-lg border border-border bg-bg-secondary/40 p-4">
			<label
				className="
					mb-3 block text-xs font-medium tracking-wider text-text-secondary uppercase
				"
			>
				Linked accounts
			</label>
			{isLoading ? (
				<div className="py-1">
					<ListSkeleton itemCount={SUPPORTED_PROVIDERS.length} />
				</div>
			) : loadError ? (
				<div className="py-4 text-center text-sm text-text-secondary">
					Could not load linked accounts.{' '}
					<button onClick={() => void fetchAccounts()} className="cursor-pointer text-accent underline hover:text-accent-hover">
						Retry
					</button>
				</div>
			) : (
				<div className="flex flex-col gap-3">
					{SUPPORTED_PROVIDERS.map((provider) => {
						const isLinked = linkedProviderIds.has(provider.id);
						const isActing = actingProvider === provider.id;
						const isAnyActing = actingProvider !== undefined;
						const Icon = provider.icon;

						return (
							<div key={provider.id} className="flex items-center justify-between gap-3">
								<div className="flex items-center gap-3">
									<div
										className="
											flex size-8 items-center justify-center rounded-full bg-bg-tertiary
											text-text-secondary
										"
									>
										<Icon className="size-4" />
									</div>
									<div>
										<p className="text-sm font-medium text-text-primary">{provider.name}</p>
										<p className="text-xs text-text-secondary">{isLinked ? 'Connected' : 'Not connected'}</p>
									</div>
								</div>
								{isLinked ? (
									canUnlink && (
										<Button
											variant="ghost"
											size="sm"
											onClick={() => void handleUnlink(provider.id)}
											disabled={isAnyActing}
											isLoading={isActing}
											className="
												gap-1.5 text-xs text-text-secondary
												hover:text-error
											"
										>
											<Unlink className="size-3" />
											Unlink
										</Button>
									)
								) : (
									<Button
										variant="outline"
										size="sm"
										onClick={() => void handleLink(provider.id)}
										disabled={isAnyActing}
										isLoading={isActing}
										className="gap-1.5 text-xs"
									>
										<Link className="size-3" />
										Link
									</Button>
								)}
							</div>
						);
					})}
				</div>
			)}
		</section>
	);
}
