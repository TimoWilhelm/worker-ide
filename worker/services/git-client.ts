/**
 * Git Client — typed wrapper around cross-worker RepoDO RPC calls.
 *
 * This is the main worker's interface to the git auxiliary worker.
 * It provides typed methods for all RepoDO operations that the IDE needs,
 * routing through a cross-worker Durable Object binding (env.REPO_DO).
 *
 * Usage:
 *   const gitClient = new GitClient(env, projectId);
 *   const tree = await gitClient.materializeTree('HEAD');
 */

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
		const repoId = toRepoId(projectId);
		const id = repoDoNamespace.idFromName(repoId);
		this.repoStub = repoDoNamespace.get(id);
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

	/**
	 * Get the decompressed content of a blob object.
	 */
	async getBlobContent(oid: string): Promise<Uint8Array | undefined> {
		return this.repoStub.getBlobContent(oid);
	}

	/**
	 * Batch get blob contents.
	 */
	async getBlobContentBatch(oids: string[]): Promise<Map<string, Uint8Array>> {
		return this.repoStub.getBlobContentBatch(oids);
	}

	// =========================================================================
	// History operations
	// =========================================================================

	/**
	 * Get commit log starting from a ref.
	 */
	async getLog(options: { ref: string; depth?: number }): Promise<CommitLogEntry[]> {
		return this.repoStub.getLog(options);
	}

	/**
	 * Compare two trees and return changed files.
	 */
	async diffTrees(baseReference: string, headReference: string): Promise<TreeDiffEntry[]> {
		return this.repoStub.diffTrees(baseReference, headReference);
	}

	/**
	 * Check if ancestorOid is reachable from descendantRef by walking all parents.
	 */
	async isAncestor(ancestorOid: string, descendantReference: string): Promise<boolean> {
		return this.repoStub.isAncestor(ancestorOid, descendantReference);
	}

	// =========================================================================
	// Ref operations
	// =========================================================================

	/**
	 * List all refs (branches + tags).
	 */
	async listRefs(): Promise<Array<{ name: string; oid: string }>> {
		return this.repoStub.listRefs();
	}

	/**
	 * Set refs (create, update, or delete).
	 */
	async setRefs(references: Array<{ name: string; oid: string }>): Promise<void> {
		return this.repoStub.setRefs(references);
	}

	/**
	 * Get HEAD info.
	 */
	async getHead(): Promise<{ target?: string; oid?: string }> {
		return this.repoStub.getHead();
	}

	/**
	 * Set HEAD target.
	 */
	async setHead(head: { target: string; oid?: string }): Promise<void> {
		return this.repoStub.setHead(head);
	}

	/**
	 * Get HEAD and all refs in one call.
	 */
	async getHeadAndRefs(): Promise<{
		head: { target?: string; oid?: string };
		refs: Array<{ name: string; oid: string }>;
	}> {
		return this.repoStub.getHeadAndRefs();
	}

	// =========================================================================
	// Ephemeral branches
	// =========================================================================

	/**
	 * Create an ephemeral ref pointing to the same commit as sourceRef.
	 */
	async createEphemeralReference(name: string, sourceReference: string): Promise<EphemeralReference> {
		return this.repoStub.createEphemeralReference(name, sourceReference);
	}

	/**
	 * Promote an ephemeral ref to a real branch.
	 */
	async promoteEphemeralReference(name: string, targetBranch: string): Promise<void> {
		return this.repoStub.promoteEphemeralReference(name, targetBranch);
	}

	/**
	 * List all ephemeral refs.
	 */
	async listEphemeralReferences(): Promise<EphemeralReference[]> {
		return this.repoStub.listEphemeralReferences();
	}

	/**
	 * Delete an ephemeral ref.
	 */
	async deleteEphemeralReference(name: string): Promise<void> {
		return this.repoStub.deleteEphemeralReference(name);
	}

	// =========================================================================
	// Repository management
	// =========================================================================

	/**
	 * Purge the entire repository (DANGEROUS).
	 */
	async purgeRepo(): Promise<{ deletedR2: number; deletedDO: boolean }> {
		return this.repoStub.purgeRepo();
	}
}
