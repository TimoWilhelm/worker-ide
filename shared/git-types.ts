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
// Artifacts "pushed" event subscription payload (queue message)
//
// Delivered by Cloudflare Artifacts event subscriptions (source
// `artifacts.repo`) whenever commits are pushed to a repository. The IDE
// consumes these to broadcast `git-status-changed` to connected clients.
// ---------------------------------------------------------------------------
export interface ArtifactsPushedEvent {
	type: 'cf.artifacts.repo.pushed';
	source: {
		type: 'artifacts.repo';
		namespace: string;
		repoName: string;
	};
	payload: {
		ref: string;
		before: string;
		after: string;
	};
}
