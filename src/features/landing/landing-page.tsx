/**
 * Landing Page
 *
 * Minimalist landing page for Worker IDE. Displays over a halftone shader
 * background and allows users to:
 * - Start a new project from a template
 * - Open a recent project
 * - Clone/remix a project by ID or URL
 *
 * This entire component is lazy-loaded via React.lazy() to keep it
 * out of the main IDE bundle.
 */

import { Copy, Hexagon, Moon, Search, Sun, X } from 'lucide-react';
import { Suspense, useCallback, useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useTheme } from '@/hooks/use-theme';
import { cloneProject, createProject } from '@/lib/api-client';
import { getRecentProjects, removeProject, trackProject } from '@/lib/recent-projects';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import { HalftoneBackground } from './halftone-background';

import type { RecentProject } from '@/lib/recent-projects';

// =============================================================================
// Constants
// =============================================================================

/**
 * Template definitions for the landing page.
 *
 * These are defined client-side to avoid an API call on page load.
 * They must stay in sync with the template registry in worker/templates.ts.
 * Only the display metadata is needed here — file contents live server-side.
 *
 * To add a new template:
 * 1. Add the template files and entry in worker/templates.ts
 * 2. Add a matching entry here with the same ID
 */
const TEMPLATE_CARDS: TemplateCardData[] = [
	{
		id: 'request-inspector',
		name: 'Request Inspector',
		description: 'Inspect HTTP headers, geolocation, and connection info from a Cloudflare Worker.',
		icon: 'Search',
	},
];

interface TemplateCardData {
	id: string;
	name: string;
	description: string;
	icon: string;
}

/**
 * Regex to extract a 64-character hex project ID from various input formats:
 * - Full URL: https://anything.dev/p/<hex64>
 * - Path: /p/<hex64>
 * - Bare ID: <hex64>
 */
const PROJECT_ID_REGEX = /(?:\/p\/)?([a-f0-9]{64})/i;

// =============================================================================
// Icon mapping
// =============================================================================

/**
 * Maps Lucide icon names (strings from template metadata) to components.
 * Add entries here when adding new templates with different icons.
 */
const ICON_MAP: Record<string, React.ComponentType<{ className?: string }>> = {
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
// Template card component
// =============================================================================

function TemplateCard({
	template,
	onSelect,
	disabled,
}: {
	template: TemplateCardData;
	onSelect: (templateId: string) => void;
	disabled: boolean;
}) {
	return (
		<button
			onClick={() => onSelect(template.id)}
			disabled={disabled}
			className={cn(
				`
					group flex cursor-pointer flex-col gap-3 rounded-lg border border-border
					p-5
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
			<div className="flex items-center gap-3">
				<div
					className={cn(
						'flex size-9 items-center justify-center rounded-md',
						'bg-accent/10 text-accent transition-colors',
						'group-hover:bg-accent/20',
					)}
				>
					<TemplateIcon name={template.icon} className="size-4" />
				</div>
				<h3 className="text-sm font-semibold text-text-primary">{template.name}</h3>
			</div>
			<p className="text-left text-xs/relaxed text-text-secondary">{template.description}</p>
		</button>
	);
}

// =============================================================================
// Recent project row
// =============================================================================

function RecentProjectRow({
	project,
	isMostRecent,
	onDelete,
}: {
	project: RecentProject;
	isMostRecent: boolean;
	onDelete: (projectId: string) => void;
}) {
	return (
		<a
			href={`/p/${project.id}`}
			className={cn(
				`
					group/row flex items-center justify-between px-3 py-2 transition-colors
					focus-visible:outline-none
				`,
				`
					text-text-secondary
					hover:bg-bg-tertiary/60 hover:text-text-primary
				`,
				isMostRecent && 'text-text-primary',
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
// Main landing page component
// =============================================================================

/**
 * Landing page component.
 * Default export for React.lazy() compatibility.
 */
export default function LandingPage() {
	const [recentProjects, setRecentProjects] = useState(getRecentProjects);
	const [cloneInput, setCloneInput] = useState('');
	const [loadingMessage, setLoadingMessage] = useState<string | undefined>();
	const [cloneError, setCloneError] = useState<string | undefined>();

	const resolvedTheme = useTheme();
	const setColorScheme = useStore((state) => state.setColorScheme);

	// Determine if the clone input contains a valid project ID
	const parsedProjectId = useMemo(() => {
		if (!cloneInput.trim()) return;
		const match = cloneInput.trim().match(PROJECT_ID_REGEX);
		return match ? match[1].toLowerCase() : undefined;
	}, [cloneInput]);

	// --- Handlers ---

	const handleCreateFromTemplate = useCallback(async (templateId: string) => {
		setLoadingMessage('Creating project...');
		try {
			const data = await createProject(templateId);
			trackProject(data.projectId, data.name);
			navigateToProject(data.url);
		} catch {
			setLoadingMessage(undefined);
		}
	}, []);

	const handleClone = useCallback(async () => {
		if (!parsedProjectId) return;

		setCloneError(undefined);
		setLoadingMessage('Cloning project...');
		try {
			const data = await cloneProject(parsedProjectId);
			trackProject(data.projectId, data.name);
			navigateToProject(data.url);
		} catch (error) {
			setLoadingMessage(undefined);
			setCloneError(error instanceof Error ? error.message : 'Failed to clone project');
		}
	}, [parsedProjectId]);

	const handleCloneKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter' && parsedProjectId) {
				void handleClone();
			}
		},
		[handleClone, parsedProjectId],
	);

	const handleDeleteProject = useCallback((projectId: string) => {
		removeProject(projectId);
		setRecentProjects((previous) => previous.filter((project) => project.id !== projectId));
	}, []);

	const isLoading = loadingMessage !== undefined;

	return (
		<div className="relative flex min-h-dvh flex-col items-center justify-center">
			{/* Halftone shader background */}
			<Suspense fallback={undefined}>
				<HalftoneBackground />
			</Suspense>

			{/* Loading overlay */}
			{isLoading && <LoadingOverlay message={loadingMessage} />}

			{/* Theme toggle — top right */}
			<div className="fixed top-4 right-4 z-10">
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
			<main className="relative z-0 w-full max-w-lg px-6 py-16">
				{/* Header / Branding */}
				<div className="mb-10 flex flex-col items-center gap-3">
					<Hexagon className="size-8 text-accent" strokeWidth={1.5} />
					<h1 className="text-xl font-semibold tracking-tight text-text-primary">Worker IDE</h1>
					<p className="text-center text-xs text-text-secondary">Build and preview Cloudflare Workers in the browser</p>
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
							grid grid-cols-1 gap-3
							sm:grid-cols-2
						"
					>
						{TEMPLATE_CARDS.map((template) => (
							<TemplateCard key={template.id} template={template} onSelect={handleCreateFromTemplate} disabled={isLoading} />
						))}
					</div>
				</section>

				{/* Clone / Remix */}
				<section className="mb-8">
					<h2
						className="
							mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
						"
					>
						Clone a project
					</h2>
					<div className="relative">
						<Copy
							className="
								pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2
								text-text-secondary
							"
						/>
						<input
							type="text"
							value={cloneInput}
							onChange={(event) => {
								setCloneInput(event.target.value);
								setCloneError(undefined);
							}}
							onKeyDown={handleCloneKeyDown}
							placeholder="Paste project URL or ID"
							disabled={isLoading}
							className={cn(
								'h-9 w-full rounded-md border bg-bg-secondary/60 pr-16 pl-9',
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
						<button
							onClick={() => void handleClone()}
							disabled={isLoading || !parsedProjectId}
							className={cn(
								'absolute top-1/2 right-1.5 -translate-y-1/2 rounded-sm px-2.5 py-1',
								'text-xs font-medium transition-colors',
								parsedProjectId && !isLoading
									? `
										cursor-pointer bg-accent text-white
										hover:bg-accent-hover
									`
									: 'cursor-not-allowed text-text-secondary opacity-40',
							)}
						>
							Clone
						</button>
					</div>
					{cloneError && <p className="mt-2 text-xs text-error">{cloneError}</p>}
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
							{recentProjects.map((project, index) => (
								<RecentProjectRow key={project.id} project={project} isMostRecent={index === 0} onDelete={handleDeleteProject} />
							))}
						</div>
					</section>
				)}
			</main>
		</div>
	);
}
