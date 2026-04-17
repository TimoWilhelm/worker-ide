import { withRetry } from '../lib/do-retry-proxy';

import type { RepoDurableObject } from '../../auxiliary/git/do/repo/repo-do';
import type { CommitTreeOptions, CommitTreeResult, TreeEntry, CommitLogEntry, TreeDiffEntry, EphemeralReference } from '@shared/git-types';

/**
 * Maps a project ID to a repository ID used by the git worker.
 * Convention: "ide/{projectId}" for IDE-created repositories.
 */
function toRepoId(projectId: string): string {
	return `ide/${projectId}`;
}

export class GitClient {
	private repoStub: DurableObjectStub<RepoDurableObject>;

	constructor(repoDoNamespace: DurableObjectNamespace<RepoDurableObject>, projectId: string) {
		const retryNamespace = withRetry(repoDoNamespace);
		const repoId = toRepoId(projectId);
		this.repoStub = retryNamespace.getByName(repoId);
	}

	// =========================================================================
	// Commit operations
	// =========================================================================

	/**
	 * Create a commit from file contents (no git client needed).
	 * Primary write path for IDE commits.
	 */
	async commitTree(options: CommitTreeOptions): Promise<CommitTreeResult> {
		return this.repoStub.commitTree(options);
	}

	// =========================================================================
	// Tree operations
	// =========================================================================

	/**
	 * Materialize the full file tree at a given ref.
	 * Returns a flat list of all files with their OIDs, modes, and sizes.
	 */
	async materializeTree(reference: string): Promise<TreeEntry[]> {
		return this.repoStub.materializeTree(reference);
	}
	async getBlobContent(oid: string): Promise<Uint8Array | undefined> {
		return this.repoStub.getBlobContent(oid);
	}
	async getBlobContentBatch(oids: string[]): Promise<Map<string, Uint8Array>> {
		return this.repoStub.getBlobContentBatch(oids);
	}

	// =========================================================================
	// History operations
	// =========================================================================
	async getLog(options: { ref: string; depth?: number }): Promise<CommitLogEntry[]> {
		return this.repoStub.getLog(options);
	}
	async diffTrees(baseReference: string, headReference: string): Promise<TreeDiffEntry[]> {
		return this.repoStub.diffTrees(baseReference, headReference);
	}
	async isAncestor(ancestorOid: string, descendantReference: string): Promise<boolean> {
		return this.repoStub.isAncestor(ancestorOid, descendantReference);
	}

	// =========================================================================
	// Ref operations
	// =========================================================================
	async listRefs(): Promise<Array<{ name: string; oid: string }>> {
		return this.repoStub.listRefs();
	}
	async setRefs(references: Array<{ name: string; oid: string }>): Promise<void> {
		return this.repoStub.setRefs(references);
	}
	async getHead(): Promise<{ target?: string; oid?: string }> {
		return this.repoStub.getHead();
	}
	async setHead(head: { target: string; oid?: string }): Promise<void> {
		return this.repoStub.setHead(head);
	}
	async getHeadAndRefs(): Promise<{
		head: { target?: string; oid?: string };
		refs: Array<{ name: string; oid: string }>;
	}> {
		return this.repoStub.getHeadAndRefs();
	}

	// =========================================================================
	// Ephemeral branches
	// =========================================================================
	async createEphemeralReference(name: string, sourceReference: string): Promise<EphemeralReference> {
		return this.repoStub.createEphemeralReference(name, sourceReference);
	}
	async promoteEphemeralReference(name: string, targetBranch: string): Promise<void> {
		return this.repoStub.promoteEphemeralReference(name, targetBranch);
	}
	async listEphemeralReferences(): Promise<EphemeralReference[]> {
		return this.repoStub.listEphemeralReferences();
	}
	async deleteEphemeralReference(name: string): Promise<void> {
		return this.repoStub.deleteEphemeralReference(name);
	}

	// =========================================================================
	// Repository management
	// =========================================================================
	async purgeRepo(): Promise<{ deletedR2: number; deletedDO: boolean }> {
		return this.repoStub.purgeRepo();
	}
}
