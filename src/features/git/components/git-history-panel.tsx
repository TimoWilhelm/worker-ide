/**
 * Git History Panel
 *
 * Shows commit history with an optional graph visualization.
 * Clicking a commit shows its detail view.
 */

import { useQuery } from '@tanstack/react-query';
import { Clock } from 'lucide-react';
import { useCallback, useMemo, useState } from 'react';

import { createApiClient } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import { GitCommitDetail } from './git-commit-detail';
import { GitHistoryGraph } from './git-history-graph';
import { computeGraphLayout } from '../lib/git-graph-layout';

import type { GitCommitEntry, GitFileDiff } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitHistoryPanelProperties {
	projectId: string;
	commits: GitCommitEntry[];
	isLoading: boolean;
	branches: Array<{ name: string; isCurrent: boolean }>;
}

// =============================================================================
// Helpers
// =============================================================================

function formatRelativeTime(timestamp: number): string {
	const now = Date.now() / 1000;
	const diff = now - timestamp;

	if (diff < 60) return 'just now';
	if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
	if (diff < 86_400) return `${Math.floor(diff / 3600)}h ago`;
	if (diff < 604_800) return `${Math.floor(diff / 86_400)}d ago`;
	if (diff < 2_592_000) return `${Math.floor(diff / 604_800)}w ago`;
	return new Date(timestamp * 1000).toLocaleDateString();
}

// =============================================================================
// Component
// =============================================================================

export function GitHistoryPanel({ projectId, commits, isLoading, branches }: GitHistoryPanelProperties) {
	const [selectedCommit, setSelectedCommit] = useState<GitCommitEntry | undefined>();

	const api = createApiClient(projectId);

	// Compute graph layout
	const graphEntries = useMemo(() => computeGraphLayout({ commits, branches }), [commits, branches]);

	// Fetch diff for selected commit
	const commitDiffQuery = useQuery({
		queryKey: ['git-diff-commit', projectId, selectedCommit?.objectId],
		queryFn: async (): Promise<GitFileDiff[]> => {
			if (!selectedCommit) return [];
			const response = await api.git.diff.commit.$get({
				query: { objectId: selectedCommit.objectId },
			});
			if (!response.ok) {
				throw new Error('Failed to fetch commit diff');
			}
			const data: { files: GitFileDiff[] } = await response.json();
			return data.files;
		},
		enabled: selectedCommit !== undefined,
		staleTime: 1000 * 30,
	});

	const handleSelectCommit = useCallback((commit: GitCommitEntry) => {
		setSelectedCommit(commit);
	}, []);

	// Detail view
	if (selectedCommit) {
		return (
			<GitCommitDetail
				commit={selectedCommit}
				files={commitDiffQuery.data}
				isLoadingDiff={commitDiffQuery.isLoading}
				onBack={() => setSelectedCommit(undefined)}
			/>
		);
	}

	// Loading state
	if (isLoading) {
		return <div className="px-3 py-4 text-center text-xs text-text-secondary">Loading history...</div>;
	}

	// Empty state
	if (commits.length === 0) {
		return <div className="px-3 py-4 text-center text-xs text-text-secondary">No commits yet</div>;
	}

	return (
		<div className="flex">
			{/* Graph column */}
			<GitHistoryGraph entries={graphEntries} />

			{/* Commit list */}
			<div className="min-w-0 flex-1">
				{graphEntries.map((entry) => (
					<button
						key={entry.objectId}
						type="button"
						onClick={() => handleSelectCommit(entry)}
						className={cn(
							`
								flex w-full cursor-pointer flex-col gap-0.5 overflow-hidden px-2 py-1.5
								text-left
							`,
							`
								transition-colors
								hover:bg-bg-tertiary
							`,
						)}
						style={{ minHeight: 32 }}
					>
						<div className="flex items-center gap-1.5">
							<span className="min-w-0 truncate text-xs text-text-primary">{entry.message.split('\n')[0]}</span>
							{/* Branch/tag labels */}
							{entry.branchNames.map((name) => (
								<span
									key={`branch-${name}`}
									className="
										shrink-0 rounded-sm bg-accent/15 px-1 text-[10px] font-medium
										text-accent
									"
								>
									{name}
								</span>
							))}
							{entry.tagNames.map((name) => (
								<span
									key={`tag-${name}`}
									className="
										shrink-0 rounded-sm bg-amber-500/15 px-1 text-[10px] font-medium
										text-amber-400
									"
								>
									{name}
								</span>
							))}
						</div>
						<div className="
							flex flex-wrap items-center gap-x-1.5 text-[10px] text-text-secondary
						">
							<span className="font-mono">{entry.abbreviatedObjectId}</span>
							<span className="flex shrink-0 items-center gap-1">
								<Clock className="size-2.5" />
								{formatRelativeTime(entry.author.timestamp)}
							</span>
						</div>
					</button>
				))}
			</div>
		</div>
	);
}
