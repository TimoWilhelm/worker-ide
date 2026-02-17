/**
 * Git Status List
 *
 * Groups git status entries into Staged, Changed, and Untracked sections.
 * Each section is collapsible with bulk stage/unstage actions.
 */

import { ChevronDown, ChevronRight, Minus, Plus } from 'lucide-react';
import { useState } from 'react';

import { Tooltip } from '@/components/ui';
import { cn } from '@/lib/utils';

import { GitFileItem } from './git-file-item';
import { groupStatusEntries } from '../lib/status-helpers';

import type { GitStatusEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitStatusListProperties {
	entries: GitStatusEntry[];
	onStage: (paths: string[]) => void;
	onUnstage: (paths: string[]) => void;
	onDiscard: (path: string) => void;
	onFileClick?: (path: string) => void;
}

interface StatusSectionProperties {
	title: string;
	entries: GitStatusEntry[];
	defaultExpanded?: boolean;
	onStageAll?: () => void;
	onUnstageAll?: () => void;
	onStageFile?: (path: string) => void;
	onUnstageFile?: (path: string) => void;
	onDiscardFile?: (path: string) => void;
	onFileClick?: (path: string) => void;
}

// =============================================================================
// StatusSection
// =============================================================================

function StatusSection({
	title,
	entries,
	defaultExpanded = true,
	onStageAll,
	onUnstageAll,
	onStageFile,
	onUnstageFile,
	onDiscardFile,
	onFileClick,
}: StatusSectionProperties) {
	const [isExpanded, setIsExpanded] = useState(defaultExpanded);

	if (entries.length === 0) {
		return;
	}

	return (
		<div>
			{/* Section header */}
			<button
				type="button"
				className={cn(
					`
						flex w-full cursor-pointer items-center gap-1 px-3 py-1 text-xs
						font-semibold tracking-wider uppercase
					`,
					`
						text-text-secondary transition-colors
						hover:text-text-primary
					`,
				)}
				onClick={() => setIsExpanded(!isExpanded)}
			>
				{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				<span>{title}</span>
				<span className="ml-1 text-text-secondary">{entries.length}</span>
				<span className="flex-1" />
				{/* Bulk action */}
				{onStageAll && (
					<Tooltip content="Stage all">
						<span
							role="button"
							tabIndex={0}
							onClick={(event) => {
								event.stopPropagation();
								onStageAll();
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.stopPropagation();
									onStageAll();
								}
							}}
							className="
								flex size-4 items-center justify-center rounded-sm text-text-secondary
								hover:text-text-primary
							"
						>
							<Plus className="size-3" />
						</span>
					</Tooltip>
				)}
				{onUnstageAll && (
					<Tooltip content="Unstage all">
						<span
							role="button"
							tabIndex={0}
							onClick={(event) => {
								event.stopPropagation();
								onUnstageAll();
							}}
							onKeyDown={(event) => {
								if (event.key === 'Enter') {
									event.stopPropagation();
									onUnstageAll();
								}
							}}
							className="
								flex size-4 items-center justify-center rounded-sm text-text-secondary
								hover:text-text-primary
							"
						>
							<Minus className="size-3" />
						</span>
					</Tooltip>
				)}
			</button>

			{/* File list */}
			{isExpanded && (
				<div>
					{entries.map((entry) => (
						<GitFileItem
							key={entry.path}
							entry={entry}
							onStage={onStageFile ? (path) => onStageFile(path) : undefined}
							onUnstage={onUnstageFile ? (path) => onUnstageFile(path) : undefined}
							onDiscard={onDiscardFile}
							onClick={onFileClick}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// GitStatusList
// =============================================================================

export function GitStatusList({ entries, onStage, onUnstage, onDiscard, onFileClick }: GitStatusListProperties) {
	const groups = groupStatusEntries(entries);

	if (groups.staged.length === 0 && groups.unstaged.length === 0 && groups.untracked.length === 0) {
		return <div className="px-3 py-4 text-center text-xs text-text-secondary">No changes detected</div>;
	}

	return (
		<div className="flex flex-col">
			<StatusSection
				title="Staged"
				entries={groups.staged}
				onUnstageAll={() => onUnstage(groups.staged.map((entry) => entry.path))}
				onUnstageFile={(path) => onUnstage([path])}
				onFileClick={onFileClick}
			/>
			<StatusSection
				title="Changes"
				entries={groups.unstaged}
				onStageAll={() => onStage(groups.unstaged.map((entry) => entry.path))}
				onStageFile={(path) => onStage([path])}
				onDiscardFile={onDiscard}
				onFileClick={onFileClick}
			/>
			<StatusSection
				title="Untracked"
				entries={groups.untracked}
				onStageAll={() => onStage(groups.untracked.map((entry) => entry.path))}
				onStageFile={(path) => onStage([path])}
				onFileClick={onFileClick}
			/>
		</div>
	);
}
