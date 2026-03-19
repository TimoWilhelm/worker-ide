/**
 * Dashboard Page
 *
 * Displays over a halftone shader background and allows users to:
 * - Start a new project from a template (compact cards + detail modal)
 * - Open a recent project
 * - Clone/remix a project by ID or URL
 *
 * This entire component is lazy-loaded via React.lazy() to keep it
 * out of the main IDE bundle.
 */

import { BookOpen, Copy, Github, Hexagon, Moon, Search, Sun, X } from 'lucide-react';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button, buttonVariants } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Spinner } from '@/components/ui/spinner';
import { VersionBadge } from '@/components/version-badge';
import { useTheme } from '@/hooks/use-theme';
import { cloneProject, createProject, fetchTemplates } from '@/lib/api-client';
import { getProjectUrl } from '@/lib/preview-origin';
import { getRecentProjects, removeProject, trackProject } from '@/lib/recent-projects';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';
import { isValidProjectId } from '@shared/project-id';

import { HalftoneBackground } from './halftone-background';

import type { RecentProject } from '@/lib/recent-projects';
import type { ProjectTemplateMeta } from '@shared/types';

// =============================================================================
// Constants
// =============================================================================

/**
 * Extract a project ID from various input formats:
 * - Full URL: https://anything.dev/p/<id>
 * - Path: /p/<id>
 * - Bare ID: <id>
 */
function extractProjectId(input: string): string | undefined {
	const pathMatch = input.match(/\/p\/([a-z\d]{1,50})(?:\/|$)/);
	if (pathMatch) return pathMatch[1];
	const bareMatch = input.match(/^([a-z\d]{1,50})$/);
	if (bareMatch) return bareMatch[1];
	return undefined;
}

// =============================================================================
// Icon mapping
// =============================================================================

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

// =============================================================================
// Loading overlay
// =============================================================================

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

// =============================================================================
// Template card (small box)
// =============================================================================

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

// =============================================================================
// Template detail modal
// =============================================================================

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

// =============================================================================
// Clone card (appears in the template grid)
// =============================================================================

function CloneCard({ onSelect, disabled }: { onSelect: () => void; disabled: boolean }) {
	return (
		<button
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

// =============================================================================
// Clone modal
// =============================================================================

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

// =============================================================================
// Recent project row
// =============================================================================

function RecentProjectRow({ project, onDelete }: { project: RecentProject; onDelete: (projectId: string) => void }) {
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
			<span className="truncate text-xs">{project.name ?? project.id.slice(0, 12)}</span>
			<div className="ml-3 flex shrink-0 items-center gap-1">
				<span
					className="
						text-xs text-text-secondary/60
						group-hover/row:hidden
					"
				>
					{formatRelativeTime(project.timestamp)}
				</span>
				<button
					onClick={(event) => {
						event.preventDefault();
						event.stopPropagation();
						onDelete(project.id);
					}}
					className="
						hidden cursor-pointer rounded-sm p-0.5 text-text-secondary/60
						transition-colors
						group-hover/row:inline-flex
						hover:text-error
					"
					aria-label={`Remove ${project.name ?? project.id.slice(0, 12)} from recent projects`}
				>
					<X className="size-3" />
				</button>
			</div>
		</a>
	);
}

// =============================================================================
// Navigation helper
// =============================================================================

/**
 * Navigate to a project URL. Defined outside the component
 * so that react-compiler doesn't flag it as a forbidden write.
 */
function navigateToProject(url: string): void {
	globalThis.location.href = url;
}

// =============================================================================
// Main dashboard page component
// =============================================================================

/**
 * Dashboard page component.
 * Default export for React.lazy() compatibility.
 */
export default function DashboardPage() {
	const [templates, setTemplates] = useState<ProjectTemplateMeta[]>([]);
	const [templatesLoaded, setTemplatesLoaded] = useState(false);
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | undefined>();
	const [recentProjects, setRecentProjects] = useState(getRecentProjects);
	const [cloneInput, setCloneInput] = useState('');
	const [cloneModalOpen, setCloneModalOpen] = useState(false);
	const [loadingMessage, setLoadingMessage] = useState<string | undefined>();
	const [cloneError, setCloneError] = useState<string | undefined>();

	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	// Fetch template metadata from the API
	useEffect(() => {
		let cancelled = false;
		void fetchTemplates().then((data) => {
			if (!cancelled) {
				setTemplates(data);
				setTemplatesLoaded(true);
			}
		});
		return () => {
			cancelled = true;
		};
	}, []);

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

	const handleCreateFromTemplate = useCallback(async (templateId: string) => {
		setLoadingMessage('Creating project...');
		try {
			const data = await createProject(templateId);
			trackProject(data.projectId, data.name);
			navigateToProject(getProjectUrl(data.projectId));
		} catch {
			setLoadingMessage(undefined);
		}
	}, []);

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
			const data = await cloneProject(parsedProjectId);
			trackProject(data.projectId, data.name);
			navigateToProject(getProjectUrl(data.projectId));
		} catch (error) {
			setLoadingMessage(undefined);
			setCloneError(error instanceof Error ? error.message : 'Failed to clone project');
		}
	}, [parsedProjectId]);

	const handleDeleteProject = useCallback((projectId: string) => {
		removeProject(projectId);
		setRecentProjects((previous) => previous.filter((project) => project.id !== projectId));
	}, []);

	// Refresh recent projects & clear loading state when the page is restored
	// from bfcache (browser back) or when the tab becomes visible again.
	useEffect(() => {
		function refreshRecentProjects() {
			setRecentProjects(getRecentProjects());
		}

		function handlePageShow(event: PageTransitionEvent) {
			if (event.persisted) {
				setLoadingMessage(undefined);
				refreshRecentProjects();
			}
		}

		function handleVisibilityChange() {
			if (document.visibilityState === 'visible') {
				refreshRecentProjects();
			}
		}

		globalThis.addEventListener('pageshow', handlePageShow);
		document.addEventListener('visibilitychange', handleVisibilityChange);
		return () => {
			globalThis.removeEventListener('pageshow', handlePageShow);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, []);

	const isLoading = loadingMessage !== undefined;

	return (
		<div className="relative flex h-dvh flex-col items-center overflow-y-auto">
			{/* Halftone shader background */}
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			{/* Loading overlay */}
			{isLoading && <LoadingOverlay message={loadingMessage} />}

			{/* Template detail modal */}
			<TemplateDetailModal
				template={selectedTemplate}
				open={selectedTemplateId !== undefined && !isLoading}
				onOpenChange={handleCloseTemplateModal}
				onCreateProject={handleCreateFromTemplate}
				isLoading={isLoading}
			/>

			{/* Clone modal */}
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

			{/* Header actions — top right */}
			<div className="fixed top-4 right-4 z-10 flex items-center gap-1">
				<a
					href="/docs"
					target="_blank"
					rel="noopener noreferrer"
					aria-label="Architecture docs"
					className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'bg-bg-secondary/40 backdrop-blur-sm' })}
				>
					<BookOpen className="size-4" />
				</a>
				<a
					href="https://github.com/TimoWilhelm/worker-ide"
					target="_blank"
					rel="noopener noreferrer"
					aria-label="GitHub repository"
					className={buttonVariants({ variant: 'ghost', size: 'icon', className: 'bg-bg-secondary/40 backdrop-blur-sm' })}
				>
					<Github className="size-4" />
				</a>
				<Button
					variant="ghost"
					size="icon"
					aria-label={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}
					onClick={() => setColorScheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
					className="bg-bg-secondary/40 backdrop-blur-sm"
				>
					{resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
				</Button>
			</div>

			{/* Main content */}
			<main
				className="
					relative z-0 w-full max-w-lg px-6 pt-24 pb-12
					sm:pt-32
				"
			>
				{/* Header / Branding */}
				<div className="mb-10 flex flex-col items-center gap-3">
					<Hexagon className="size-8 text-accent" strokeWidth={1.5} />
					<h1 className="text-xl font-semibold tracking-tight text-text-primary">Codemaxxing</h1>
				</div>

				{/* Template cards */}
				<section className="mb-8">
					<h2
						className="
							mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Start a new project
					</h2>
					<div
						className="
							grid grid-cols-3 gap-2
							sm:grid-cols-4
						"
					>
						{templatesLoaded ? (
							<>
								{templates.map((template) => (
									<TemplateCard key={template.id} template={template} onSelect={handleSelectTemplate} disabled={isLoading} />
								))}
								<CloneCard onSelect={handleOpenCloneModal} disabled={isLoading} />
							</>
						) : (
							Array.from({ length: 4 }, (_, index) => <TemplateCardSkeleton key={index} />)
						)}
					</div>
				</section>

				{/* Recent projects */}
				{recentProjects.length > 0 && (
					<section>
						<h2
							className="
								mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
							"
						>
							Recent projects
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
							{recentProjects.map((project) => (
								<RecentProjectRow key={project.id} project={project} onDelete={handleDeleteProject} />
							))}
						</div>
					</section>
				)}
			</main>
			<VersionBadge className="fixed right-4 bottom-4" />
		</div>
	);
}
