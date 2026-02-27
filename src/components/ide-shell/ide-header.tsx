/**
 * IDE header bar with project name, AI toggle, theme toggle, download, and mobile menu.
 */

import { BookOpen, Bot, Download, EllipsisVertical, Github, Hexagon, Moon, Pencil, Sun } from 'lucide-react';

import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { Modal, ModalBody } from '@/components/ui/modal';
import { Tooltip } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/version-badge';
import { cn } from '@/lib/utils';

import { RecentProjectsDropdown } from './recent-projects-dropdown';

import type { useProjectName } from './use-project-name';

interface IDEHeaderProperties {
	projectId: string;
	projectNameState: ReturnType<typeof useProjectName>;
	resolvedTheme: 'light' | 'dark';
	setColorScheme: (scheme: 'light' | 'dark') => void;
	isMobile: boolean;
	isSaving: boolean;
	aiPanelVisible: boolean;
	toggleAIPanel: () => void;
	isAiProcessing: boolean;
	mobileMenuOpen: boolean;
	setMobileMenuOpen: (open: boolean) => void;
	onDownload: () => void;
	onNewProject: () => void;
}

export function IDEHeader({
	projectId,
	projectNameState,
	resolvedTheme,
	setColorScheme,
	isMobile,
	isSaving,
	aiPanelVisible,
	toggleAIPanel,
	isAiProcessing,
	mobileMenuOpen,
	setMobileMenuOpen,
	onDownload,
	onNewProject,
}: IDEHeaderProperties) {
	const {
		projectName,
		isEditingName,
		editNameValue,
		setEditNameValue,
		nameInputReference,
		handleStartRename,
		handleSaveRename,
		handleCancelRename,
	} = projectNameState;

	return (
		<>
			<header
				className="
					flex h-10 shrink-0 items-center justify-between border-b border-border
					bg-bg-secondary px-3
				"
			>
				<div className="flex min-w-0 items-center gap-2">
					<Tooltip content="Back to home">
						<a
							href="/"
							className="
								shrink-0 text-accent transition-colors
								hover:text-accent-hover
							"
							aria-label="Back to home"
						>
							<Hexagon className="size-4" />
						</a>
					</Tooltip>
					{isEditingName ? (
						<div className="flex items-center gap-1">
							<input
								ref={nameInputReference}
								value={editNameValue}
								onChange={(event) => setEditNameValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') void handleSaveRename();
									if (event.key === 'Escape') handleCancelRename();
								}}
								onBlur={() => void handleSaveRename()}
								className="
									h-6 w-40 rounded-sm border border-accent bg-bg-primary px-1.5 text-sm
									text-text-primary
									focus:outline-none
								"
								maxLength={60}
							/>
						</div>
					) : (
						<div className="group flex min-w-0 items-center gap-1.5">
							<h1 className="truncate font-semibold text-text-primary">{projectName ?? 'Worker IDE'}</h1>
							<Tooltip content="Rename project">
								<button
									onClick={handleStartRename}
									className="
										cursor-pointer text-text-secondary opacity-0 transition-opacity
										hover-always:text-accent
										group-hover-always:opacity-100
									"
									aria-label="Rename project"
								>
									<Pencil className="size-3" />
								</button>
							</Tooltip>
						</div>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2">
					{/* Save indicator */}
					{isSaving && <span className="text-xs text-text-secondary">Saving...</span>}

					{/* Recent projects */}
					<RecentProjectsDropdown currentProjectId={projectId} onNewProject={onNewProject} />

					{/* AI toggle (desktop only — mobile uses bottom tab bar) */}
					{!isMobile && (
						<Tooltip content="Toggle Agent panel">
							<div className="relative">
								<Button
									variant="ghost"
									size="icon"
									aria-label="Toggle Agent panel"
									onClick={toggleAIPanel}
									className={cn(aiPanelVisible && 'text-accent')}
								>
									<Bot className="size-4" />
								</Button>
								{isAiProcessing && !aiPanelVisible && <BorderBeam duration={1.5} />}
							</div>
						</Tooltip>
					)}

					{/* Theme toggle */}
					<Tooltip content={resolvedTheme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'}>
						<Button
							variant="ghost"
							size="icon"
							aria-label="Toggle color theme"
							onClick={() => setColorScheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
						>
							{resolvedTheme === 'dark' ? <Sun className="size-4" /> : <Moon className="size-4" />}
						</Button>
					</Tooltip>

					{/* Download */}
					<Tooltip content="Download project">
						<Button variant="ghost" size="icon" aria-label="Download project" onClick={onDownload}>
							<Download className="size-4" />
						</Button>
					</Tooltip>

					{/* More menu (mobile only — exposes footer links) */}
					{isMobile && (
						<Tooltip content="More">
							<Button variant="ghost" size="icon" aria-label="More options" onClick={() => setMobileMenuOpen(true)}>
								<EllipsisVertical className="size-4" />
							</Button>
						</Tooltip>
					)}
				</div>
			</header>

			{/* Mobile menu dialog — links that are in the desktop footer */}
			<Modal open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} title="Links">
				<ModalBody className="flex flex-col gap-1">
					<a
						href="/docs"
						target="_blank"
						rel="noopener noreferrer"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
					>
						<BookOpen className="size-4 text-text-secondary" />
						Documentation
					</a>
					<a
						href="https://github.com/TimoWilhelm/worker-ide"
						target="_blank"
						rel="noopener noreferrer"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
					>
						<Github className="size-4 text-text-secondary" />
						GitHub
					</a>
					<div
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary
						"
					>
						<VersionBadge withProvider={false} />
					</div>
				</ModalBody>
			</Modal>
		</>
	);
}
