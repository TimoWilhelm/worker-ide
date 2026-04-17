// ---------------------------------------------------------------------------
// Tree materialization
// ---------------------------------------------------------------------------
export interface TreeEntry {
	path: string;
	oid: string;
	mode: number;
	size: number;
}

// ---------------------------------------------------------------------------
// Direct-write commit (commitTree RPC)
// ---------------------------------------------------------------------------
export interface GitAuthorInfo {
	name: string;
	email: string;
}
export interface CommitFileEntry {
	path: string;
	content: Uint8Array;
	mode?: number;
}
export interface CommitTreeOptions {
	parentRef?: string;
	files: CommitFileEntry[];
	deletedPaths?: string[];
	message: string;
	author: GitAuthorInfo;
}
export interface CommitTreeResult {
	commitOid: string;
	treeOid: string;
}

// ---------------------------------------------------------------------------
// Tree diff
// ---------------------------------------------------------------------------
export type TreeDiffStatus = 'added' | 'modified' | 'deleted';
export interface TreeDiffEntry {
	path: string;
	status: TreeDiffStatus;
	baseOid?: string;
	headOid?: string;
}

// ---------------------------------------------------------------------------
// Commit log
// ---------------------------------------------------------------------------
export interface CommitLogEntry {
	oid: string;
	message: string;
	author: {
		name: string;
		email: string;
		timestamp: number;
	};
	parentOids: string[];
	treeOid: string;
}

// ---------------------------------------------------------------------------
// Ephemeral branches
// ---------------------------------------------------------------------------
export interface EphemeralReference {
	name: string;
	oid: string;
}

// ---------------------------------------------------------------------------
// Push event (queue message)
// ---------------------------------------------------------------------------
export interface GitPushEvent {
	type: 'push';
	repoId: string;
	timestamp: number;
}
