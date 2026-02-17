/**
 * Git feature barrel export.
 */

// Components
export { GitPanel } from './components/git-panel';
export { GitStatusList } from './components/git-status-list';
export { GitFileItem } from './components/git-file-item';
export { GitCommitForm } from './components/git-commit-form';
export { GitBranchSelector } from './components/git-branch-selector';
export { GitBranchDialog } from './components/git-branch-dialog';
export { GitHistoryPanel } from './components/git-history-panel';
export { GitHistoryGraph } from './components/git-history-graph';
export { GitCommitDetail } from './components/git-commit-detail';

// Hooks
export { useGitStatus } from './hooks/use-git-status';
export { useGitLog } from './hooks/use-git-log';
export { useGitBranches } from './hooks/use-git-branches';
export { useGitMutations } from './hooks/use-git-mutations';

// Utilities
export { getStatusDisplay, groupStatusEntries, countChangedFiles, isStagedStatus } from './lib/status-helpers';
export { computeGraphLayout, getMaxColumns, COLUMN_WIDTH, ROW_HEIGHT, COMMIT_RADIUS } from './lib/git-graph-layout';
