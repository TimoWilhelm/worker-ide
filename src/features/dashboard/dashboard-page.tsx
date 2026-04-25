import { useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpen, Bug, Copy, Github, Hexagon, Search, Trash2 } from 'lucide-react';
import { motion } from 'motion/react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router';

import { HalftoneBackground } from '@/components/halftone-background';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { Tooltip, TooltipProvider } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/version-badge';
import { CreateOrgModal } from '@/features/org/create-org-modal';
import { PendingInvitationsBanner } from '@/features/org/pending-invitations-banner';
import {
	cloneProject,
	createProject,
	deleteProject,
	fetchOrgLimits,
	fetchOrgProjects,
	fetchTemplates,
	fetchUserLimits,
} from '@/lib/api-client';
import { fadeUpVariants, springGentle, staggerContainer } from '@/lib/motion-config';
import { getProjectUrl } from '@/lib/preview-origin';
import { cn, formatRelativeTime } from '@/lib/utils';
import { isValidProjectId } from '@shared/project-id';

import type { OrgProject } from '@/lib/api-client';
import type { ProjectTemplateMeta } from '@shared/types';

/**
 * Extract a project ID from various input formats:
 * - Full URL: https://anything.dev/p/<id>
 * - Path: /p/<id>
 * - Bare ID: <id>
 */
function extractProjectId(input: string): string | undefined {
	const pathMatch = input.match(/\/p\/([a-z\d]{1,50})(?:[/?#]|$)/);
	if (pathMatch) return pathMatch[1];
	const bareMatch = input.match(/^([a-z\d]{1,50})$/);
	if (bareMatch) return bareMatch[1];
	return undefined;
}

/**
 * Maps Lucide icon names (strings from template metadata) to components.
 * Add entries here when adding new templates with different icons.
 */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
	Hexagon,
	Search,
};

function TemplateIcon({ name, className }: { name: string; className?: string }) {
	const IconComponent = ICON_MAP[name];
	if (!IconComponent) return <Search className={className} />;
	return <IconComponent className={className} />;
}

function LoadingOverlay({ message }: { message: string }) {
	return (
		<div
			className="
				fixed inset-0 z-50 flex items-center justify-center bg-bg-primary/80
				backdrop-blur-sm
			"
		>
			<div className="flex flex-col items-center gap-4">
				<Spinner size="lg" />
				<p className="text-sm text-text-secondary">{message}</p>
			</div>
		</div>
	);
}

interface DashboardUser {
	name: string;
	email: string;
	image?: string;
}

function getDashboardGreetingPrefix(currentDate: Date): string {
	const hour = currentDate.getHours();
	if (hour < 12) {
		return 'Good morning';
	}

	if (hour < 18) {
		return 'Hello';
	}

	return 'Hi';
}

function getDashboardDisplayName(user: DashboardUser | undefined): string {
	const trimmedName = user?.name.trim();
	if (trimmedName) {
		return trimmedName;
	}

	const emailName = user?.email.split('@')[0]?.trim();
	if (emailName) {
		return emailName;
	}

	return '';
}

function getDashboardGreeting(user: DashboardUser | undefined): string {
	const displayName = getDashboardDisplayName(user);
	if (!displayName) {
		return getDashboardGreetingPrefix(new Date());
	}

	return `${getDashboardGreetingPrefix(new Date())} ${displayName}`;
}

function TemplateCard({
	template,
	onSelect,
	disabled,
}: {
	template: ProjectTemplateMeta;
	onSelect: (templateId: string) => void;
	disabled: boolean;
}) {
	return (
		<button
			data-local-focus="true"
			onClick={() => onSelect(template.id)}
			disabled={disabled}
			className={cn(
				`
					group flex cursor-pointer flex-col items-center gap-2 rounded-lg border
					border-border p-4
				`,
				'bg-bg-secondary/60 backdrop-blur-sm transition-all',
				'hover:border-accent/50 hover:bg-bg-secondary/80',
				`
					focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
					focus-visible:ring-offset-bg-primary focus-visible:outline-none
				`,
				'disabled:pointer-events-none disabled:opacity-50',
			)}
		>
			<div
				className={cn(
					'flex size-8 items-center justify-center rounded-md',
					'bg-accent/10 text-accent transition-colors',
					'group-hover:bg-accent/20',
				)}
			>
				<TemplateIcon name={template.icon} className="size-4" />
			</div>
			<span className="text-center text-xs font-medium text-text-primary">{template.name}</span>
		</button>
	);
}

function TemplateCardSkeleton() {
	return (
		<div className={cn('flex flex-col items-center gap-2 rounded-lg border border-border p-4', 'bg-bg-secondary/40 backdrop-blur-sm')}>
			<div className="size-8 animate-pulse rounded-md bg-bg-tertiary" />
			<div className="h-4 w-16 animate-pulse rounded-sm bg-bg-tertiary" />
		</div>
	);
}

function TemplateDetailModal({
	template,
	open,
	onOpenChange,
	onCreateProject,
	isLoading,
}: {
	template: ProjectTemplateMeta | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onCreateProject: (templateId: string) => void;
	isLoading: boolean;
}) {
	if (!template) return;

	return (
		<Modal open={open} onOpenChange={onOpenChange} title={template.name}>
			<ModalBody>
				<div className="flex items-start gap-4">
					<div className={cn('flex size-10 shrink-0 items-center justify-center rounded-lg', 'bg-accent/10 text-accent')}>
						<TemplateIcon name={template.icon} className="size-5" />
					</div>
					<p className="text-sm/relaxed text-text-secondary">{template.description}</p>
				</div>
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button size="sm" onClick={() => onCreateProject(template.id)} disabled={isLoading} isLoading={isLoading} loadingText="Creating...">
					Create Project
				</Button>
			</ModalFooter>
		</Modal>
	);
}

function CloneCard({ onSelect, disabled }: { onSelect: () => void; disabled: boolean }) {
	return (
		<button
			data-local-focus="true"
			onClick={onSelect}
			disabled={disabled}
			className={cn(
				`
					group flex cursor-pointer flex-col items-center gap-2 rounded-lg border
					border-border p-4
				`,
				'bg-bg-secondary/60 backdrop-blur-sm transition-all',
				'hover:border-accent/50 hover:bg-bg-secondary/80',
				`
					focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
					focus-visible:ring-offset-bg-primary focus-visible:outline-none
				`,
				'disabled:pointer-events-none disabled:opacity-50',
			)}
		>
			<div
				className={cn(
					'flex size-8 items-center justify-center rounded-md',
					'bg-accent/10 text-accent transition-colors',
					'group-hover:bg-accent/20',
				)}
			>
				<Copy className="size-4" />
			</div>
			<span className="text-center text-xs font-medium text-text-primary">Clone a project</span>
		</button>
	);
}

function CloneModal({
	open,
	onOpenChange,
	cloneInput,
	onCloneInputChange,
	parsedProjectId,
	onClone,
	cloneError,
	isLoading,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	cloneInput: string;
	onCloneInputChange: (value: string) => void;
	parsedProjectId: string | undefined;
	onClone: () => void;
	cloneError: string | undefined;
	isLoading: boolean;
}) {
	const inputReference = useRef<HTMLInputElement>(null);

	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Clone a project">
			<ModalBody>
				<p className="mb-3 text-sm text-text-secondary">Paste a project URL or ID to create a copy.</p>
				<div className="relative">
					<Copy
						className="
							pointer-events-none absolute top-1/2 left-3 z-10 size-3.5
							-translate-y-1/2 text-text-secondary
						"
					/>
					<input
						ref={inputReference}
						type="text"
						value={cloneInput}
						onChange={(event) => onCloneInputChange(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter' && parsedProjectId) {
								onClone();
							}
						}}
						placeholder="Project URL or ID"
						disabled={isLoading}
						className={cn(
							'h-9 w-full rounded-md border bg-bg-secondary/60 pr-3 pl-9',
							`
								text-xs text-text-primary
								placeholder:text-text-secondary/50
							`,
							'backdrop-blur-sm transition-colors',
							`
								focus-within:border-accent
								focus:outline-none
							`,
							cloneError ? 'border-error/50' : 'border-border',
						)}
					/>
				</div>
				{cloneError && <p className="mt-2 text-xs text-error">{cloneError}</p>}
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)}>
					Cancel
				</Button>
				<Button size="sm" onClick={onClone} disabled={isLoading || !parsedProjectId} isLoading={isLoading} loadingText="Cloning...">
					Clone
				</Button>
			</ModalFooter>
		</Modal>
	);
}

function ProjectRow({ project, onDelete }: { project: OrgProject; onDelete: (project: OrgProject) => void }) {
	return (
		<a
			href={getProjectUrl(project.id)}
			className={cn(
				`
					group/row flex items-center justify-between px-3 py-2 transition-colors
					focus-visible:outline-none
				`,
				`
					text-text-secondary
					hover:bg-bg-tertiary/60 hover:text-text-primary
				`,
			)}
		>
			<span className="truncate text-xs">{project.name || project.id.slice(0, 12)}</span>
			<div className="ml-3 flex shrink-0 items-center gap-1">
				<span
					className="
						text-xs text-text-secondary/60
						group-hover/row:hidden
					"
				>
					{formatRelativeTime(new Date(project.lastActivityAt ?? project.updatedAt).getTime())}
				</span>
				<button
					onPointerDown={(event) => event.stopPropagation()}
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onDelete(project);
					}}
					className="
						hidden cursor-pointer rounded-sm p-0.5 text-text-secondary/60
						transition-colors
						group-hover/row:inline-flex
						hover:text-error
					"
					aria-label={`Delete ${project.name || project.id.slice(0, 12)}`}
				>
					<Trash2 className="size-3" />
				</button>
			</div>
		</a>
	);
}

function DeleteProjectModal({
	project,
	open,
	onOpenChange,
	onConfirm,
	isDeleting,
}: {
	project: OrgProject | undefined;
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	isDeleting: boolean;
}) {
	const [confirmText, setConfirmText] = useState('');
	const [lastProjectId, setLastProjectId] = useState<string | undefined>();
	const isConfirmed = confirmText.toLowerCase() === 'delete';

	// Reset confirmation text when a different project is targeted
	if (project?.id !== lastProjectId) {
		setLastProjectId(project?.id);
		setConfirmText('');
	}

	if (!project) return;

	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Delete project">
			<ModalBody>
				<div className="space-y-4">
					<p className="text-sm font-medium">Are you sure you want to delete this project?</p>
					<p
						className="
							truncate rounded-sm border border-border bg-bg-tertiary px-2 py-1 text-sm
							font-medium text-text-primary
						"
					>
						{project.name || project.id.slice(0, 12)}
					</p>
					<p className="text-xs text-text-secondary">This action cannot be undone.</p>
					<div>
						<label className="mb-1.5 block text-xs text-text-secondary">
							Type <strong className="text-text-primary uppercase">delete</strong> to confirm
						</label>
						<input
							type="text"
							value={confirmText}
							onChange={(event) => setConfirmText(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === 'Enter' && isConfirmed && !isDeleting) onConfirm();
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
				<Button variant="secondary" size="sm" onClick={() => onOpenChange(false)} disabled={isDeleting}>
					Cancel
				</Button>
				<Button
					size="sm"
					variant="danger"
					onClick={onConfirm}
					disabled={isDeleting || !isConfirmed}
					isLoading={isDeleting}
					loadingText="Deleting..."
				>
					Delete
				</Button>
			</ModalFooter>
		</Modal>
	);
}

/**
 * Dashboard page component.
 * Default export for React.lazy() compatibility.
 */
interface DashboardPageProperties {
	organizationId: string;
	organizations: Array<{ id: string; name: string; slug: string; plan?: string }>;
	isCreateOrgMode?: boolean;
	user?: DashboardUser;
}

export default function DashboardPage({ organizationId, organizations, isCreateOrgMode, user }: DashboardPageProperties) {
	const navigate = useNavigate();
	const [scrollContainer, setScrollContainer] = useState<HTMLDivElement | undefined>();
	const [createOrgOpen, setCreateOrgOpen] = useState(!!isCreateOrgMode);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>();
	const [cloneInput, setCloneInput] = useState('');
	const [cloneModalOpen, setCloneModalOpen] = useState(false);
	const [loadingMessage, setLoadingMessage] = useState<string | undefined>();
	const [cloneError, setCloneError] = useState<string | undefined>();

	// Fetch template metadata from the API
	const templatesQuery = useQuery({
		queryKey: ['templates'],
		queryFn: fetchTemplates,
		staleTime: 1000 * 60 * 5,
	});
	const templates = useMemo(() => templatesQuery.data ?? [], [templatesQuery.data]);
	const templatesLoaded = !templatesQuery.isLoading;

	// Fetch org projects from D1
	const projectsQuery = useQuery({
		queryKey: ['org-projects', organizationId],
		queryFn: () => fetchOrgProjects(organizationId),
		staleTime: 1000 * 30,
		enabled: !isCreateOrgMode && !!organizationId,
	});
	const orgProjects = useMemo(() => projectsQuery.data ?? [], [projectsQuery.data]);

	// Fetch resolved org limits (plan-based + entitlement overrides)
	const limitsQuery = useQuery({
		queryKey: ['org-limits', organizationId],
		queryFn: () => fetchOrgLimits(organizationId),
		staleTime: 1000 * 60,
		enabled: !isCreateOrgMode && !!organizationId,
	});
	const orgLimits = limitsQuery.data;
	const projectLimitReached = !!orgLimits && orgLimits.currentProjects >= orgLimits.maxProjects;

	const selectedTemplate = useMemo(() => templates.find((template) => template.id === selectedTemplateId), [templates, selectedTemplateId]);

	const parsedProjectId = useMemo(() => {
		if (!cloneInput.trim()) return;
		const candidate = extractProjectId(cloneInput.trim());
		return candidate && isValidProjectId(candidate) ? candidate : undefined;
	}, [cloneInput]);

	// --- Handlers ---

	const handleSelectTemplate = useCallback((templateId: string) => {
		setSelectedTemplateId(templateId);
	}, []);

	const handleCloseTemplateModal = useCallback((open: boolean) => {
		if (!open) {
			setSelectedTemplateId(undefined);
		}
	}, []);

	const queryClient = useQueryClient();

	const handleCreateFromTemplate = useCallback(
		async (templateId: string) => {
			setLoadingMessage('Creating project...');
			try {
				const data = await createProject(organizationId, templateId);
				void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
				void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
				void navigate(getProjectUrl(data.projectId));
			} catch {
				setLoadingMessage(undefined);
				toast.error('Could not create the project. Please try again.');
			}
		},
		[organizationId, queryClient, navigate],
	);

	const handleOpenCloneModal = useCallback(() => {
		setCloneModalOpen(true);
		setCloneInput('');
		setCloneError(undefined);
	}, []);

	const handleCloseCloneModal = useCallback((open: boolean) => {
		if (!open) {
			setCloneModalOpen(false);
			setCloneError(undefined);
		}
	}, []);

	const handleCloneInputChange = useCallback((value: string) => {
		setCloneInput(value);
		setCloneError(undefined);
	}, []);

	const handleClone = useCallback(async () => {
		if (!parsedProjectId) return;

		setCloneError(undefined);
		setLoadingMessage('Cloning project...');
		try {
			const data = await cloneProject(organizationId, parsedProjectId);
			void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
			void navigate(getProjectUrl(data.projectId));
		} catch (error) {
			setLoadingMessage(undefined);
			setCloneError(error instanceof Error ? error.message : 'Failed to clone project');
		}
	}, [organizationId, parsedProjectId, queryClient, navigate]);

	const [deleteTarget, setDeleteTarget] = useState<OrgProject | undefined>();
	const [isDeleting, setIsDeleting] = useState(false);

	const handleDeleteProject = useCallback((project: OrgProject) => {
		setDeleteTarget(project);
	}, []);

	const handleConfirmDelete = useCallback(async () => {
		if (!deleteTarget) return;
		setIsDeleting(true);
		try {
			await deleteProject(organizationId, deleteTarget.id);
			void queryClient.invalidateQueries({ queryKey: ['org-projects'] });
			void queryClient.invalidateQueries({ queryKey: ['org-limits'] });
			setDeleteTarget(undefined);
			toast.success(`"${deleteTarget.name || deleteTarget.id.slice(0, 12)}" deleted`);
		} catch {
			toast.error('Failed to delete project. Please try again.');
		} finally {
			setIsDeleting(false);
		}
	}, [organizationId, deleteTarget, queryClient]);

	const handleCloseDeleteModal = useCallback(
		(open: boolean) => {
			if (!open && !isDeleting) {
				setDeleteTarget(undefined);
			}
		},
		[isDeleting],
	);

	const isLoading = loadingMessage !== undefined;

	const dashboardGreeting = useMemo(() => getDashboardGreeting(user), [user]);

	// Clear loading state when the page is restored from bfcache (browser back/forward)
	useEffect(() => {
		function handlePageShow(event: PageTransitionEvent) {
			if (event.persisted) {
				setLoadingMessage(undefined);
				setSelectedTemplateId(undefined);
				setCloneModalOpen(false);
				void queryClient.invalidateQueries({ queryKey: ['org-projects', organizationId] });
				void queryClient.invalidateQueries({ queryKey: ['org-limits', organizationId] });
			}
		}
		globalThis.addEventListener('pageshow', handlePageShow);
		return () => globalThis.removeEventListener('pageshow', handlePageShow);
	}, [organizationId, queryClient]);

	const hasNoOrgs = organizations.length === 0;
	const userLimitsQuery = useQuery({
		queryKey: ['user-limits'],
		queryFn: fetchUserLimits,
		staleTime: 1000 * 60,
	});

	return (
		<div ref={(element) => setScrollContainer(element ?? undefined)} className="relative h-dvh overflow-y-auto">
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			<PageHeader
				variant="floating"
				scrollContainer={scrollContainer}
				organizationSwitcher={
					isCreateOrgMode
						? undefined
						: {
								organizations,
								currentOrganizationId: organizationId,
								currentOrganizationName: organizations.find((organization) => organization.id === organizationId)?.name ?? '',
							}
				}
			/>

			{isLoading && <LoadingOverlay message={loadingMessage} />}

			<TemplateDetailModal
				template={selectedTemplate}
				open={selectedTemplateId !== undefined && !isLoading}
				onOpenChange={handleCloseTemplateModal}
				onCreateProject={handleCreateFromTemplate}
				isLoading={isLoading}
			/>

			<DeleteProjectModal
				project={deleteTarget}
				open={deleteTarget !== undefined}
				onOpenChange={handleCloseDeleteModal}
				onConfirm={() => void handleConfirmDelete()}
				isDeleting={isDeleting}
			/>

			<CreateOrgModal
				open={createOrgOpen}
				onOpenChange={setCreateOrgOpen}
				freeOrganizationCount={userLimitsQuery.data?.currentFreeOrganizations ?? 0}
				maxFreeOrganizations={userLimitsQuery.data?.maxFreeOrganizations}
				required={hasNoOrgs}
				userName={user?.name}
			/>

			<CloneModal
				open={cloneModalOpen && !isLoading}
				onOpenChange={handleCloseCloneModal}
				cloneInput={cloneInput}
				onCloneInputChange={handleCloneInputChange}
				parsedProjectId={parsedProjectId}
				onClone={() => void handleClone()}
				cloneError={cloneError}
				isLoading={isLoading}
			/>

			<main
				className="
					relative z-0 mx-auto w-full max-w-lg px-6 pt-24 pb-12
					sm:pt-32
				"
			>
				<motion.div
					className="mb-10 flex flex-col items-center gap-3"
					initial={{ opacity: 0, y: 10 }}
					animate={{ opacity: 1, y: 0 }}
					transition={springGentle}
				>
					<Hexagon className="size-8 text-accent" strokeWidth={1.5} />
					<h1
						className="
							text-center text-xl font-semibold tracking-tight text-text-primary
						"
					>
						{dashboardGreeting}
					</h1>
				</motion.div>

				<section className="mb-8">
					<h2
						className="
							mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Start a new project
						{orgLimits && (
							<span className="ml-1 tracking-normal normal-case">
								({orgLimits.currentProjects}/{orgLimits.maxProjects})
							</span>
						)}
					</h2>
					{projectLimitReached && (
						<p className="mb-3 text-xs text-text-secondary/80">
							Project limit reached ({orgLimits?.maxProjects}). Upgrade your plan to create more projects.
						</p>
					)}
					<motion.div
						className="
							grid grid-cols-3 gap-2
							sm:grid-cols-4
						"
						variants={staggerContainer(0.05)}
						initial="hidden"
						animate="visible"
					>
						{templatesQuery.isError ? (
							<div className="col-span-full py-4 text-center text-sm text-text-secondary">
								Could not load templates.{' '}
								<button
									onClick={() => void templatesQuery.refetch()}
									className="
										cursor-pointer text-accent underline
										hover:text-accent-hover
									"
								>
									Retry
								</button>
							</div>
						) : templatesLoaded ? (
							<>
								{templates.map((template) => (
									<motion.div key={template.id} variants={fadeUpVariants} transition={springGentle}>
										<TemplateCard template={template} onSelect={handleSelectTemplate} disabled={isLoading || projectLimitReached} />
									</motion.div>
								))}
								<motion.div variants={fadeUpVariants} transition={springGentle}>
									<CloneCard onSelect={handleOpenCloneModal} disabled={isLoading || projectLimitReached} />
								</motion.div>
							</>
						) : (
							Array.from({ length: 4 }, (_, index) => <TemplateCardSkeleton key={index} />)
						)}
					</motion.div>
				</section>

				<PendingInvitationsBanner />

				{projectsQuery.isError && (
					<section className="mb-8">
						<div
							className="
								rounded-lg border border-border bg-bg-secondary/40 p-4 text-center
								text-sm text-text-secondary backdrop-blur-sm
							"
						>
							Could not load your projects.{' '}
							<button onClick={() => void projectsQuery.refetch()} className="cursor-pointer text-accent underline hover:text-accent-hover">
								Retry
							</button>
						</div>
					</section>
				)}
				{orgProjects.length > 0 && (
					<section>
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Your projects
						</h2>
						<div
							className={cn(
								`
									max-h-46 overflow-y-auto rounded-lg border border-border
									bg-bg-secondary/40 backdrop-blur-sm
								`,
								'divide-y divide-border',
							)}
						>
							{orgProjects.map((project) => (
								<ProjectRow key={project.id} project={project} onDelete={handleDeleteProject} />
							))}
						</div>
					</section>
				)}
			</main>
			<TooltipProvider>
				<div
					className="
						fixed right-4 bottom-4 flex items-center gap-4 text-xs text-text-secondary
					"
				>
					<Tooltip content="GitHub">
						<a
							href="https://github.com/TimoWilhelm/worker-ide"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="GitHub repository"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<Github className="size-3.5" />
						</a>
					</Tooltip>
					<Tooltip content="Report a bug">
						<a
							href="https://github.com/TimoWilhelm/worker-ide/issues/new?template=bug-report.yml"
							target="_blank"
							rel="noopener noreferrer"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<Bug className="size-3.5" />
						</a>
					</Tooltip>
					<Tooltip content="Docs">
						<a
							href="/docs"
							target="_blank"
							rel="noopener noreferrer"
							aria-label="Architecture docs"
							className="
								rounded-sm transition-colors
								hover:text-accent
								focus-visible:text-accent
							"
						>
							<BookOpen className="size-3.5" />
						</a>
					</Tooltip>
					<VersionBadge withProvider={false} />
				</div>
			</TooltipProvider>
		</div>
	);
}
