export interface TreeEntry {
	/** File mode (e.g., "100644" for regular file, "40000" for directory) */
	mode: string;
	/** Entry name (filename or directory name) */
	name: string;
	/** Object ID of the blob (file) or tree (directory) */
	oid: string;
}

export interface CommitInfo {
	oid: string;
	tree: string;
	parents: string[];
	author?: { name: string; email: string; when: number; tz: string };
	committer?: { name: string; email: string; when: number; tz: string };
	message: string;
}

export interface MergeSideOptions {
	/** Maximum commits to scan before stopping (default: limit * 3) */
	scanLimit?: number;
	/** Time budget in milliseconds before stopping (default: 150ms) */
	timeBudgetMs?: number;
	/** Number of mainline commits to probe for early stop (default: 300) */
	mainlineProbe?: number;
}

export type CommitDiffChangeType = 'A' | 'M' | 'D';

export interface CommitDiffEntry {
	path: string;
	changeType: CommitDiffChangeType;
	oldOid?: string;
	newOid?: string;
	oldMode?: string;
	newMode?: string;
}

export interface CommitDiffResult {
	baseCommitOid?: string;
	compareMode: 'root' | 'first-parent';
	entries: CommitDiffEntry[];
	added: number;
	modified: number;
	deleted: number;
	total: number;
	truncated: boolean;
	truncateReason?: 'max_files' | 'max_tree_pairs' | 'time_budget' | 'soft_budget';
}

export interface CommitFilePatchResult {
	path: string;
	changeType: CommitDiffChangeType;
	oldOid?: string;
	newOid?: string;
	oldTooLarge?: boolean;
	newTooLarge?: boolean;
	binary?: boolean;
	skipped?: boolean;
	skipReason?: 'binary' | 'too_large' | 'not_found' | 'too_many_lines';
	patch?: string;
}
