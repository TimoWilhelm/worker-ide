/**
 * Dropdown menu showing recent projects with ability to switch or create new.
 */

import { Library, Plus, X } from 'lucide-react';
import { useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { getRecentProjects, removeProject, type RecentProject } from '@/lib/recent-projects';
import { cn, formatRelativeTime } from '@/lib/utils';

export function RecentProjectsDropdown({ currentProjectId, onNewProject }: { currentProjectId: string; onNewProject: () => void }) {
	const [projects, setProjects] = useState<RecentProject[]>([]);

	const handleOpenChange = useCallback((open: boolean) => {
		if (open) {
			setProjects(getRecentProjects());
		}
	}, []);

	const handleDeleteProject = useCallback((event: React.MouseEvent, projectId: string) => {
		event.preventDefault();
		event.stopPropagation();
		removeProject(projectId);
		setProjects((previous) => previous.filter((project) => project.id !== projectId));
	}, []);

	return (
		<DropdownMenu onOpenChange={handleOpenChange}>
			<Tooltip content="Recent Projects" side="bottom">
				<DropdownMenuTrigger asChild>
					<Button variant="ghost" size="icon">
						<Library className="size-4" />
					</Button>
				</DropdownMenuTrigger>
			</Tooltip>
			<DropdownMenuContent align="end" className="max-h-80 w-60 overflow-y-auto">
				{projects.map((project) => {
					const isCurrent = project.id === currentProjectId;
					return (
						<DropdownMenuItem
							key={project.id}
							onSelect={() => {
								if (!isCurrent) {
									globalThis.location.href = `/p/${project.id}`;
								}
							}}
							className={cn('group/item', isCurrent && 'bg-accent/10 text-accent')}
						>
							<div className="flex w-full items-center justify-between">
								<span className="truncate text-xs">
									{project.name ?? project.id.slice(0, 8)}
									{isCurrent && ' (current)'}
								</span>
								<div className="ml-2 flex shrink-0 items-center gap-1">
									<span className={cn('text-xs text-text-secondary', !isCurrent && 'group-hover/item:hidden')}>
										{formatRelativeTime(project.timestamp)}
									</span>
									{!isCurrent && (
										<button
											onPointerDown={(event) => event.stopPropagation()}
											onClick={(event) => handleDeleteProject(event, project.id)}
											className="
												hidden rounded-sm p-0.5 text-text-secondary/60 transition-colors
												group-hover/item:inline-flex
												hover:text-error
											"
											aria-label={`Remove ${project.name ?? project.id.slice(0, 8)} from recent projects`}
										>
											<X className="size-3" />
										</button>
									)}
								</div>
							</div>
						</DropdownMenuItem>
					);
				})}
				<DropdownMenuSeparator />
				<DropdownMenuItem onSelect={onNewProject}>
					<Plus className="size-3.5" />
					<span>New Project</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
