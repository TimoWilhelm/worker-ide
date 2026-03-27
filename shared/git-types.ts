/**
 * Types shared between the main worker and the git auxiliary worker.
 *
 * These types define the RPC contract for cross-worker Durable Object calls
 * between worker-ide (GitClient) and git-worker (RepoDurableObject).
 */

// ---------------------------------------------------------------------------
// Tree materialization
// ---------------------------------------------------------------------------

/** A single entry in a materialized git tree (flat file listing). */
export interface TreeEntry {
	/** Relative file path (e.g. "src/app.tsx") */
	path: string;
	/** Git blob OID (SHA-1 hex) */
	oid: string;
	/** Git file mode (e.g. 0o100644 for regular file, 0o100755 for executable) */
	mode: number;
	/** File size in bytes */
	size: number;
}

// ---------------------------------------------------------------------------
// Direct-write commit (commitTree RPC)
// ---------------------------------------------------------------------------

/** Author/committer info for a commit. */
export interface GitAuthorInfo {
	name: string;
	email: string;
}

/** A file to include in a direct-write commit. */
export interface CommitFileEntry {
	/** Relative path (e.g. "src/app.tsx") */
	path: string;
	/** Raw file content */
	content: Uint8Array;
	/** Git file mode (defaults to 0o100644 for regular file) */
	mode?: number;
}

/** Options for the commitTree RPC. */
export interface CommitTreeOptions {
	/** Ref to use as parent (e.g. "refs/heads/main"). Omit for initial commit. */
	parentRef?: string;
	/** Files to add or update in the commit. */
	files: CommitFileEntry[];
	/** Paths to delete from the tree (relative to root). */
	deletedPaths?: string[];
	/** Commit message. */
	message: string;
	/** Author info. */
	author: GitAuthorInfo;
}

/** Result of a commitTree RPC call. */
export interface CommitTreeResult {
	/** SHA-1 of the new commit object. */
	commitOid: string;
	/** SHA-1 of the root tree object. */
	treeOid: string;
}

// ---------------------------------------------------------------------------
// Tree diff
// ---------------------------------------------------------------------------

/** Change type for a file between two trees. */
export type TreeDiffStatus = 'added' | 'modified' | 'deleted';

/** A single file change between two tree objects. */
export interface TreeDiffEntry {
	path: string;
	status: TreeDiffStatus;
	/** OID in the base tree (absent for "added" status). */
	baseOid?: string;
	/** OID in the head tree (absent for "deleted" status). */
	headOid?: string;
}

// ---------------------------------------------------------------------------
// Commit log
// ---------------------------------------------------------------------------

/** Parsed commit info returned by getLog. */
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

/** An ephemeral ref entry. */
export interface EphemeralReference {
	name: string;
	oid: string;
}

// ---------------------------------------------------------------------------
// Push event (queue message)
// ---------------------------------------------------------------------------

/** Message published to the git-push-events queue on successful push. */
export interface GitPushEvent {
	type: 'push';
	repoId: string;
	timestamp: number;
}
