import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, EyeOff } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { ModalContentSkeleton } from '@/components/ui/skeleton';
import { toast } from '@/components/ui/toast-store';
import { createApiClient, deleteProject, fetchProjectMeta } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';
import { invalidateProjectAccess } from '@/lib/project-access';
import { cn } from '@/lib/utils';

import type { OrgProject } from '@/lib/api-client';

interface ProjectSettingsModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

type Visibility = 'public' | 'private';

async function fetchVisibility(projectId: string): Promise<Visibility> {
	const api = createApiClient(projectId);
	const response = await api.project.visibility.$get({});
	if (!response.ok) {
		await throwApiError(response, 'Failed to fetch visibility');
	}
	const data = await response.json();
	return data.visibility === 'private' ? 'private' : 'public';
}

async function updateVisibility(projectId: string, visibility: Visibility): Promise<void> {
	const api = createApiClient(projectId);
	const response = await api.project.visibility.$put({ json: { visibility } });
	if (!response.ok) {
		await throwApiError(response, 'Failed to update visibility');
	}
}

export function ProjectSettingsModal({ open, onOpenChange, projectId }: ProjectSettingsModalProperties) {
	const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);

	const handleSettingsOpenChange = useCallback(
		(nextOpen: boolean) => {
			onOpenChange(nextOpen);
			if (nextOpen) {
				setDeleteConfirmOpen(false);
			}
		},
		[onOpenChange],
	);

	return (
		(open || deleteConfirmOpen) && (
			<ProjectSettingsContent
				open={open}
				onOpenChange={handleSettingsOpenChange}
				projectId={projectId}
				deleteConfirmOpen={deleteConfirmOpen}
				setDeleteConfirmOpen={setDeleteConfirmOpen}
			/>
		)
	);
}

function ProjectSettingsContent({
	open,
	onOpenChange,
	projectId,
	deleteConfirmOpen,
	setDeleteConfirmOpen,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	deleteConfirmOpen: boolean;
	setDeleteConfirmOpen: (open: boolean) => void;
}) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const [isSaving, setIsSaving] = useState(false);
	const [isDeleting, setIsDeleting] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [deleteConfirmText, setDeleteConfirmText] = useState('');

	const metaQuery = useQuery({
		queryKey: ['project-meta', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 0,
	});

	const visibilityQuery = useQuery({
		queryKey: ['project-visibility', projectId],
		queryFn: () => fetchVisibility(projectId),
		staleTime: 0,
	});

	const [visibility, setVisibility] = useState<Visibility>('public');

	useEffect(() => {
		if (visibilityQuery.data) {
			setVisibility(visibilityQuery.data);
		}
	}, [visibilityQuery.data]);

	const isDeleteConfirmed = deleteConfirmText.toLowerCase() === 'delete';

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setError(undefined);
		try {
			await updateVisibility(projectId, visibility);
			onOpenChange(false);
		} catch (error) {
			const message = error instanceof Error ? error.message : 'Failed to save settings';
			setError(message);
		} finally {
			setIsSaving(false);
		}
	}, [projectId, visibility, onOpenChange]);

	const handleDelete = useCallback(async () => {
		const projectMeta = metaQuery.data;
		if (!projectMeta?.organizationId) {
			setError('Failed to load project details');
			return;
		}

		setIsDeleting(true);
		setError(undefined);
		try {
			await deleteProject(projectMeta.organizationId, projectId);
			invalidateProjectAccess(projectId);
			queryClient.removeQueries({ queryKey: ['project-meta', projectId] });
			queryClient.removeQueries({ queryKey: ['project-visibility', projectId] });
			queryClient.setQueryData<Array<OrgProject> | undefined>(['org-projects', projectMeta.organizationId], (previousProjects) =>
				previousProjects?.filter((project) => project.id !== projectId),
			);
			void queryClient.invalidateQueries({ queryKey: ['org-projects', projectMeta.organizationId] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits', projectMeta.organizationId] });
			void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
			onOpenChange(false);
			setDeleteConfirmOpen(false);
			toast.success('Project deleted');
			void navigate(projectMeta.organizationSlug ? `/org/${projectMeta.organizationSlug}` : '/', { replace: true });
		} catch (deleteError) {
			setError(deleteError instanceof Error ? deleteError.message : 'Failed to delete project');
		} finally {
			setIsDeleting(false);
		}
	}, [metaQuery.data, navigate, onOpenChange, projectId, queryClient, setDeleteConfirmOpen]);

	return (
		<>
			<Modal open={open} onOpenChange={onOpenChange} title="Project Settings" className="w-[420px]">
				{visibilityQuery.isLoading || metaQuery.isLoading ? (
					<ModalBody className="min-h-40">
						<ModalContentSkeleton />
					</ModalBody>
				) : visibilityQuery.isError || metaQuery.isError || !metaQuery.data ? (
					<>
						<ModalBody className="flex flex-col gap-4">
							<div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2.5">
								<p className="text-xs text-red-500">Failed to load project settings</p>
							</div>
						</ModalBody>
						<ModalFooter>
							<Button variant="secondary" onClick={() => onOpenChange(false)}>
								Close
							</Button>
						</ModalFooter>
					</>
				) : (
					<>
						<ModalBody className="flex flex-col gap-4">
							{error && (
								<div className="rounded-sm border border-red-500/30 bg-red-500/10 p-2.5">
									<p className="text-xs text-red-500">{error}</p>
								</div>
							)}

							<fieldset className="flex flex-col gap-2">
								<legend className="text-xs font-medium text-text-secondary">Preview Visibility</legend>
								<p className="text-xs text-text-secondary/70">Controls who can access the live preview of this project.</p>
								<div className="flex flex-col gap-1.5">
									<label
										className={cn(
											`
												flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
												transition-colors
											`,
											visibility === 'public' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
										)}
										htmlFor="vis-public"
									>
										<input
											id="vis-public"
											type="radio"
											name="visibility"
											value="public"
											checked={visibility === 'public'}
											onChange={() => setVisibility('public')}
											className="mt-0.5 accent-accent"
										/>
										<div className="flex flex-col gap-0.5">
											<span
												className="
													flex items-center gap-1.5 text-xs font-medium text-text-primary
												"
											>
												<Eye className="size-3.5" />
												Public
											</span>
											<span className="text-xs text-text-secondary/70">Anyone with the link can view the preview.</span>
										</div>
									</label>
									<label
										className={cn(
											`
												flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
												transition-colors
											`,
											visibility === 'private' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
										)}
										htmlFor="vis-private"
									>
										<input
											id="vis-private"
											type="radio"
											name="visibility"
											value="private"
											checked={visibility === 'private'}
											onChange={() => setVisibility('private')}
											className="mt-0.5 accent-accent"
										/>
										<div className="flex flex-col gap-0.5">
											<span
												className="
													flex items-center gap-1.5 text-xs font-medium text-text-primary
												"
											>
												<EyeOff className="size-3.5" />
												Private
											</span>
											<span className="text-xs text-text-secondary/70">Only organization members can view the preview.</span>
										</div>
									</label>
								</div>
							</fieldset>

							{metaQuery.data.permissions.delete && (
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
												<p className="text-sm font-medium text-text-primary">Delete project</p>
												<p className="text-xs text-text-secondary">Permanently delete this project.</p>
											</div>
											<Button
												variant="danger"
												size="sm"
												disabled={isSaving || isDeleting}
												onClick={() => {
													setDeleteConfirmText('');
													onOpenChange(false);
													setDeleteConfirmOpen(true);
												}}
											>
												Delete
											</Button>
										</div>
									</div>
								</section>
							)}
						</ModalBody>
						<ModalFooter>
							<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isSaving || isDeleting}>
								Cancel
							</Button>
							<Button onClick={handleSave} disabled={isSaving || isDeleting} isLoading={isSaving}>
								Save
							</Button>
						</ModalFooter>
					</>
				)}
			</Modal>
			<Modal
				open={deleteConfirmOpen}
				onOpenChange={(open) => {
					if (!open && !isDeleting) {
						setDeleteConfirmOpen(false);
						setDeleteConfirmText('');
					}
				}}
				title="Delete project"
			>
				<ModalBody>
					<div className="space-y-4">
						<p className="text-sm font-medium">Are you sure you want to delete this project?</p>
						<p
							className="
								truncate rounded-sm border border-border bg-bg-tertiary px-2 py-1
								text-sm font-medium text-text-primary
							"
						>
							{metaQuery.data?.name ?? ''}
						</p>
						<p className="text-xs text-text-secondary">This action cannot be undone.</p>
						<div>
							<label className="mb-1.5 block text-xs text-text-secondary">
								Type <strong className="text-text-primary uppercase">delete</strong> to confirm
							</label>
							<input
								type="text"
								value={deleteConfirmText}
								onChange={(event) => setDeleteConfirmText(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter' && isDeleteConfirmed && !isDeleting) {
										void handleDelete();
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
					<Button
						variant="secondary"
						size="sm"
						onClick={() => {
							setDeleteConfirmOpen(false);
							setDeleteConfirmText('');
						}}
						disabled={isDeleting}
					>
						Cancel
					</Button>
					<Button
						size="sm"
						variant="danger"
						onClick={() => void handleDelete()}
						disabled={isDeleting || !isDeleteConfirmed}
						isLoading={isDeleting}
					>
						Delete
					</Button>
				</ModalFooter>
			</Modal>
		</>
	);
}
