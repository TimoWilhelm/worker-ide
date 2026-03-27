/**
 * Git operation routes.
 * Handles git operations: status, staging, commits, branches, tags, stash, and diffs.
 *
 * Operations are delegated to two services:
 * - GitClient: cross-worker RPC to the git auxiliary worker's RepoDO (for git objects, refs, history)
 * - WorkingTreeService: local comparison of ProjectDO's working tree vs committed tree
 *
 * The working tree (files the editor/agent sees) lives in the ProjectDO's SQLite.
 * Git storage (objects, refs, packs) lives in the git worker's RepoDO + R2.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';
import {
	gitStageSchema,
	gitDiscardSchema,
	gitCommitSchema,
	gitBranchSchema,
	gitBranchRenameSchema,
	gitCheckoutSchema,
	gitMergeSchema,
	gitTagSchema,
	gitStashSchema,
	gitLogQuerySchema,
	gitGraphQuerySchema,
	gitDiffQuerySchema,
	gitCommitDiffQuerySchema,
	gitFileDiffAtCommitQuerySchema,
	gitBranchNameQuerySchema,
	gitTagNameQuerySchema,
} from '@shared/validation';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';
import { httpError } from '../lib/http-error';
import { GitClient } from '../services/git-client';
import { computeStatus, collectChanges, applyTree } from '../services/working-tree';

import type { AppEnvironment } from '../types';
import type { GitStatusEntry, GitBranchInfo, GitCommitEntry, GitFileDiff } from '@shared/types';

// =============================================================================
// Helpers
// =============================================================================

function getGitClient(c: { env: Env; var: { projectId: string } }): GitClient {
	return new GitClient(c.env.REPO_DO, c.var.projectId);
}

const PROJECT_ROOT = '/project';

interface GitStatusResponse {
	entries: GitStatusEntry[];
	initialized: boolean;
}

/**
 * Read the current git status using the working tree service.
 * This compares ProjectDO's files against the git worker's committed tree.
 */
async function readGitStatus(fileSystem: typeof import('node:fs/promises'), gitClient: GitClient): Promise<GitStatusResponse> {
	try {
		const committedTree = await gitClient.materializeTree('HEAD');
		const entries = await computeStatus(fileSystem, PROJECT_ROOT, committedTree);
		return { entries, initialized: true };
	} catch {
		return { entries: [], initialized: false };
	}
}

/**
 * Broadcast git-status-changed to connected WebSocket clients via the coordinator.
 * Uses waitUntil to ensure the broadcast completes even after the response is sent.
 */
function broadcastGitStatusChanged(projectId: string, executionContext: { waitUntil: (promise: Promise<unknown>) => void }): void {
	try {
		const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
		const coordinatorStub = coordinatorNamespace.get(coordinatorId);
		executionContext.waitUntil(coordinatorStub.sendMessage({ type: 'git-status-changed' }).catch(() => {}));
	} catch {
		// Best-effort broadcast
	}
}

// =============================================================================
// Routes
// =============================================================================

export const gitRoutes = new Hono<AppEnvironment>()

	// =========================================================================
	// Initialize
	// =========================================================================

	/**
	 * POST /api/git/init — Initialize a git repository.
	 * Creates an initial commit with all current working tree files.
	 */
	.post('/git/init', async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				// Collect all files from the working tree
				const committedTree = await gitClient.materializeTree('HEAD').catch(() => []);
				const { files } = await collectChanges(fileSystem, PROJECT_ROOT, committedTree);

				if (files.length > 0) {
					await gitClient.commitTree({
						files,
						message: 'Initial commit',
						author: { name: 'IDE User', email: 'user@example.com' },
					});
				}
			});

			return c.json({ success: true });
		} catch (error) {
			console.error('Git init error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to initialize git repository';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	// =========================================================================
	// Status
	// =========================================================================

	/**
	 * GET /api/git/status — Get the status of all changed files.
	 */
	.get('/git/status', async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let result: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');
				result = await readGitStatus(fileSystem, gitClient);
			});

			return c.json(result);
		} catch (error) {
			console.error('Git status error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git status');
		}
	})

	// =========================================================================
	// Staging
	// =========================================================================

	/**
	 * POST /api/git/stage — Stage files for commit.
	 * Stores staged paths in the ProjectDO and returns updated status.
	 */
	.post('/git/stage', zValidator('json', gitStageSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { paths } = c.req.valid('json');

		try {
			await fsStub.addStagedPaths(paths);

			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');
				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			// Mark the staged paths in the status entries
			const stagedSet = new Set(await fsStub.getStagedPaths());
			gitStatus.entries = gitStatus.entries.map((entry) => ({
				...entry,
				staged: stagedSet.has(entry.path),
			}));

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git stage error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to stage files');
		}
	})

	/**
	 * POST /api/git/unstage — Unstage files.
	 */
	.post('/git/unstage', zValidator('json', gitStageSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { paths } = c.req.valid('json');

		try {
			await fsStub.removeStagedPaths(paths);

			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');
				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			const stagedSet = new Set(await fsStub.getStagedPaths());
			gitStatus.entries = gitStatus.entries.map((entry) => ({
				...entry,
				staged: stagedSet.has(entry.path),
			}));

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git unstage error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to unstage files');
		}
	})

	/**
	 * POST /api/git/stage-all — Stage all changed files.
	 */
	.post('/git/stage-all', async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');
				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			// Stage all changed paths
			const allPaths = gitStatus.entries.map((entry) => entry.path);
			if (allPaths.length > 0) {
				await fsStub.setStagedPaths(allPaths);
			}

			gitStatus.entries = gitStatus.entries.map((entry) => ({ ...entry, staged: true }));

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git stage-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to stage all files');
		}
	})

	/**
	 * POST /api/git/unstage-all — Unstage all files.
	 */
	.post('/git/unstage-all', async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');

		try {
			await fsStub.clearStagedPaths();

			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');
				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git unstage-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to unstage all files');
		}
	})

	/**
	 * POST /api/git/discard — Discard changes for a file (restore from committed version).
	 */
	.post('/git/discard', zValidator('json', gitDiscardSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { path: filePath } = c.req.valid('json');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				// Get the committed version of this file
				const committedTree = await gitClient.materializeTree('HEAD');
				const committedFile = committedTree.find((entry) => entry.path === filePath);

				if (committedFile) {
					// File exists in committed tree — restore it
					const content = await gitClient.getBlobContent(committedFile.oid);
					if (!content) {
						throw new Error(`Failed to fetch committed content for ${filePath}`);
					}
					const fullPath = `${PROJECT_ROOT}/${filePath}`;
					const lastSlash = fullPath.lastIndexOf('/');
					if (lastSlash > 0) {
						await fileSystem.mkdir(fullPath.slice(0, lastSlash), { recursive: true });
					}
					await fileSystem.writeFile(fullPath, content);
				} else {
					// File doesn't exist in committed tree — it was added, so delete it
					try {
						await fileSystem.unlink(`${PROJECT_ROOT}/${filePath}`);
					} catch {
						// File may already be gone
					}
				}

				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			// Preserve staged state for other files
			const stagedSet = new Set(await fsStub.getStagedPaths());
			stagedSet.delete(filePath);
			await fsStub.setStagedPaths([...stagedSet]);

			gitStatus.entries = gitStatus.entries.map((entry) => ({
				...entry,
				staged: stagedSet.has(entry.path),
			}));

			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git discard error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to discard changes');
		}
	})

	/**
	 * POST /api/git/discard-all — Discard all working directory changes.
	 */
	.post('/git/discard-all', async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				// Restore entire working tree from HEAD
				const committedTree = await gitClient.materializeTree('HEAD');
				await applyTree(fileSystem, PROJECT_ROOT, committedTree, (oid) => gitClient.getBlobContent(oid));

				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			await fsStub.clearStagedPaths();

			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git discard-all error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to discard all changes');
		}
	})

	// =========================================================================
	// Commits
	// =========================================================================

	/**
	 * POST /api/git/commit — Create a commit with staged (or all) changes.
	 */
	.post('/git/commit', zValidator('json', gitCommitSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { message } = c.req.valid('json');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let commitOid = '';
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				// Get staged paths (if any)
				const stagedPaths = await fsStub.getStagedPaths();
				const committedTree = await gitClient.materializeTree('HEAD').catch(() => []);

				// Collect changes (all or staged only)
				const { files, deletedPaths } = await collectChanges(
					fileSystem,
					PROJECT_ROOT,
					committedTree,
					stagedPaths.length > 0 ? stagedPaths : undefined,
				);

				if (files.length === 0 && deletedPaths.length === 0) {
					throw new Error('Nothing to commit');
				}

				const result = await gitClient.commitTree({
					parentRef: 'HEAD',
					files,
					deletedPaths,
					message,
					author: { name: 'IDE User', email: 'user@example.com' },
				});

				commitOid = result.commitOid;

				// Clear staged paths after commit
				await fsStub.clearStagedPaths();

				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);

			return c.json({ objectId: commitOid, gitStatus });
		} catch (error) {
			console.error('Git commit error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create commit';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * GET /api/git/log — Get commit history.
	 */
	.get('/git/log', zValidator('query', gitLogQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { reference, depth } = c.req.valid('query');

		try {
			const logEntries = await gitClient.getLog({
				ref: reference ?? 'HEAD',
				depth: depth ?? 50,
			});

			// Map to the frontend's expected GitCommitEntry shape
			const commits: GitCommitEntry[] = logEntries.map((entry) => ({
				objectId: entry.oid,
				abbreviatedObjectId: entry.oid.slice(0, 7),
				message: entry.message,
				author: entry.author,
				parentObjectIds: entry.parentOids,
			}));

			return c.json({ commits });
		} catch (error) {
			console.error('Git log error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git log');
		}
	})

	/**
	 * GET /api/git/log/graph — Get commit history with graph layout data.
	 */
	.get('/git/log/graph', zValidator('query', gitGraphQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { maxCount } = c.req.valid('query');

		try {
			const logEntries = await gitClient.getLog({
				ref: 'HEAD',
				depth: maxCount ?? 100,
			});

			const commits: GitCommitEntry[] = logEntries.map((entry) => ({
				objectId: entry.oid,
				abbreviatedObjectId: entry.oid.slice(0, 7),
				message: entry.message,
				author: entry.author,
				parentObjectIds: entry.parentOids,
			}));

			return c.json({ commits });
		} catch (error) {
			console.error('Git graph error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get git graph');
		}
	})

	// =========================================================================
	// Branches
	// =========================================================================

	/**
	 * GET /api/git/branches — List all branches.
	 */
	.get('/git/branches', async (c) => {
		const gitClient = getGitClient(c);

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();
			const currentBranch = head.target?.replace('refs/heads/', '');

			const branches: GitBranchInfo[] = refs
				.filter((reference) => reference.name.startsWith('refs/heads/'))
				.map((reference) => {
					const name = reference.name.replace('refs/heads/', '');
					return { name, isCurrent: name === currentBranch };
				});

			return c.json({ branches, current: currentBranch });
		} catch (error) {
			console.error('Git branches error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to list branches');
		}
	})

	/**
	 * POST /api/git/branch — Create a new branch.
	 */
	.post('/git/branch', zValidator('json', gitBranchSchema), async (c) => {
		const gitClient = getGitClient(c);
		const { name, checkout } = c.req.valid('json');

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();
			const currentBranch = head.target ?? 'refs/heads/main';
			const currentReference = refs.find((reference) => reference.name === currentBranch);

			if (!currentReference) {
				throw new Error('Cannot determine current branch commit');
			}

			// Create new branch pointing to the same commit
			const newBranchReference = `refs/heads/${name}`;
			const existing = refs.find((reference) => reference.name === newBranchReference);
			if (existing) {
				throw new Error(`Branch '${name}' already exists`);
			}

			await gitClient.setRefs([...refs, { name: newBranchReference, oid: currentReference.oid }]);

			// If checkout requested, update HEAD
			if (checkout) {
				await gitClient.setHead({ target: newBranchReference });
			}

			return c.json({ success: true });
		} catch (error) {
			console.error('Git create branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create branch';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * DELETE /api/git/branch — Delete a branch.
	 */
	.delete('/git/branch', zValidator('query', gitBranchNameQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { name } = c.req.valid('query');

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();
			const branchReference = `refs/heads/${name}`;
			const currentBranch = head.target;

			if (branchReference === currentBranch) {
				throw new Error('Cannot delete the current branch');
			}

			const updatedReferences = refs.filter((reference) => reference.name !== branchReference);
			if (updatedReferences.length === refs.length) {
				throw new Error(`Branch '${name}' not found`);
			}

			await gitClient.setRefs(updatedReferences);
			return c.json({ success: true });
		} catch (error) {
			console.error('Git delete branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to delete branch';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * POST /api/git/branch/rename — Rename a branch.
	 */
	.post('/git/branch/rename', zValidator('json', gitBranchRenameSchema), async (c) => {
		const gitClient = getGitClient(c);
		const { oldName, newName } = c.req.valid('json');

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();
			const oldReference = `refs/heads/${oldName}`;
			const newReference = `refs/heads/${newName}`;

			const existing = refs.find((reference) => reference.name === oldReference);
			if (!existing) {
				throw new Error(`Branch '${oldName}' not found`);
			}

			const duplicate = refs.find((reference) => reference.name === newReference);
			if (duplicate) {
				throw new Error(`Branch '${newName}' already exists`);
			}

			const updatedReferences = [...refs.filter((reference) => reference.name !== oldReference), { name: newReference, oid: existing.oid }];

			await gitClient.setRefs(updatedReferences);

			// Update HEAD if the renamed branch was the current branch
			if (head.target === oldReference) {
				await gitClient.setHead({ target: newReference });
			}

			return c.json({ success: true });
		} catch (error) {
			console.error('Git rename branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to rename branch';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * POST /api/git/checkout — Checkout a branch or ref.
	 */
	.post('/git/checkout', zValidator('json', gitCheckoutSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { reference } = c.req.valid('json');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			// Resolve the target ref — only branches are supported for checkout
			const references = await gitClient.listRefs();
			const targetReference =
				references.find((r) => r.name === `refs/heads/${reference}`) ??
				references.find((r) => r.name === reference && r.name.startsWith('refs/heads/'));

			if (!targetReference) {
				throw new Error(`Branch '${reference}' not found`);
			}

			// Update HEAD to point to the target branch
			await gitClient.setHead({ target: targetReference.name });

			// Materialize the target tree into the working directory
			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				const targetTree = await gitClient.materializeTree(targetReference.name);
				await applyTree(fileSystem, PROJECT_ROOT, targetTree, (oid) => gitClient.getBlobContent(oid));

				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			await fsStub.clearStagedPaths();

			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git checkout error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to checkout';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * POST /api/git/merge — Merge a branch into the current branch.
	 * Currently supports fast-forward merges only.
	 */
	.post('/git/merge', zValidator('json', gitMergeSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { branch } = c.req.valid('json');

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();
			const currentBranch = head.target;
			if (!currentBranch) throw new Error('HEAD is detached');

			const currentReference = refs.find((r) => r.name === currentBranch);
			const mergeReference = refs.find((r) => r.name === `refs/heads/${branch}`);

			if (!currentReference || !mergeReference) {
				throw new Error(`Branch '${branch}' not found`);
			}

			if (currentReference.oid === mergeReference.oid) {
				const { mount, withMounts } = await import('worker-fs-mount');
				let gitStatus: GitStatusResponse = { entries: [], initialized: false };
				await withMounts(async () => {
					mount(PROJECT_ROOT, fsStub);
					const fileSystem = await import('node:fs/promises');
					gitStatus = await readGitStatus(fileSystem, gitClient);
				});
				return c.json({ alreadyMerged: true, gitStatus });
			}

			// Verify fast-forward: the current commit must be an ancestor of the merge target.
			// Uses BFS through all parents (not just first-parent) for correctness.
			const ancestorCheck = await gitClient.isAncestor(currentReference.oid, mergeReference.oid);
			if (!ancestorCheck) {
				throw new Error(`Cannot fast-forward: branches have diverged. Merge of '${branch}' requires a merge commit (not yet supported).`);
			}

			// Fast-forward: update the current branch to the merge target's commit
			const updatedReferences = refs.map((r) => (r.name === currentBranch ? { ...r, oid: mergeReference.oid } : r));
			await gitClient.setRefs(updatedReferences);

			// Update working tree to the new HEAD
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				const targetTree = await gitClient.materializeTree(currentBranch);
				await applyTree(fileSystem, PROJECT_ROOT, targetTree, (oid) => gitClient.getBlobContent(oid));

				gitStatus = await readGitStatus(fileSystem, gitClient);
			});

			broadcastGitStatusChanged(c.get('projectId'), c.executionCtx);

			return c.json({ objectId: mergeReference.oid, fastForward: true, gitStatus });
		} catch (error) {
			console.error('Git merge error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to merge';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	// =========================================================================
	// Tags
	// =========================================================================

	/**
	 * GET /api/git/tags — List all tags.
	 */
	.get('/git/tags', async (c) => {
		const gitClient = getGitClient(c);

		try {
			const references = await gitClient.listRefs();
			const tags = references
				.filter((reference) => reference.name.startsWith('refs/tags/'))
				.map((reference) => reference.name.replace('refs/tags/', ''));

			return c.json({ tags });
		} catch (error) {
			console.error('Git tags error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to list tags');
		}
	})

	/**
	 * POST /api/git/tag — Create a tag.
	 */
	.post('/git/tag', zValidator('json', gitTagSchema), async (c) => {
		const gitClient = getGitClient(c);
		const { name, reference } = c.req.valid('json');

		try {
			const { head, refs } = await gitClient.getHeadAndRefs();

			// Resolve what the tag should point to
			let targetOid: string | undefined;
			if (reference) {
				const targetReference = refs.find((r) => r.name === reference || r.name === `refs/heads/${reference}`);
				targetOid = targetReference?.oid;
			} else {
				const currentBranch = head.target;
				if (currentBranch) {
					const currentReference = refs.find((r) => r.name === currentBranch);
					targetOid = currentReference?.oid;
				}
				targetOid = targetOid ?? head.oid;
			}

			if (!targetOid) throw new Error('Cannot resolve reference for tag');

			const tagReference = `refs/tags/${name}`;
			const existing = refs.find((r) => r.name === tagReference);
			if (existing) throw new Error(`Tag '${name}' already exists`);

			await gitClient.setRefs([...refs, { name: tagReference, oid: targetOid }]);
			return c.json({ success: true });
		} catch (error) {
			console.error('Git create tag error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create tag';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * DELETE /api/git/tag — Delete a tag.
	 */
	.delete('/git/tag', zValidator('query', gitTagNameQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { name } = c.req.valid('query');

		try {
			const references = await gitClient.listRefs();
			const tagReference = `refs/tags/${name}`;
			const updatedReferences = references.filter((r) => r.name !== tagReference);

			if (updatedReferences.length === references.length) {
				throw new Error(`Tag '${name}' not found`);
			}

			await gitClient.setRefs(updatedReferences);
			return c.json({ success: true });
		} catch (error) {
			console.error('Git delete tag error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to delete tag';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	// =========================================================================
	// Stash (implemented as ephemeral branches)
	// =========================================================================

	/**
	 * POST /api/git/stash — Perform a stash operation.
	 * Stash is implemented using ephemeral branches:
	 * - push: commit working tree changes to an ephemeral ref
	 * - pop: restore from ephemeral ref and delete it
	 * - apply: restore from ephemeral ref (keep it)
	 * - drop: delete an ephemeral ref
	 * - clear: delete all stash ephemeral refs
	 */
	.post('/git/stash', zValidator('json', gitStashSchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { action, index, message: stashMessage } = c.req.valid('json');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let gitStatus: GitStatusResponse = { entries: [], initialized: false };

			switch (action) {
				case 'push': {
					await withMounts(async () => {
						mount(PROJECT_ROOT, fsStub);
						const fileSystem = await import('node:fs/promises');

						const committedTree = await gitClient.materializeTree('HEAD');
						const { files, deletedPaths } = await collectChanges(fileSystem, PROJECT_ROOT, committedTree);

						if (files.length === 0 && deletedPaths.length === 0) {
							throw new Error('No changes to stash');
						}

						// Commit directly to an ephemeral ref to avoid advancing the branch pointer.
						// This prevents a race where a concurrent commit could see the transient state.
						const stashName = `stash-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
						const ephemeralReference = `refs/ephemeral/${stashName}`;
						await gitClient.createEphemeralReference(stashName, 'HEAD');

						try {
							await gitClient.commitTree({
								parentRef: ephemeralReference,
								files,
								deletedPaths,
								message: stashMessage ?? `WIP on stash: ${stashName}`,
								author: { name: 'IDE User', email: 'user@example.com' },
							});
						} catch (commitError) {
							// Clean up orphaned ephemeral ref on failure
							await gitClient.deleteEphemeralReference(stashName).catch(() => {});
							throw commitError;
						}

						// Restore working tree to HEAD
						await applyTree(fileSystem, PROJECT_ROOT, committedTree, (oid) => gitClient.getBlobContent(oid));
						gitStatus = await readGitStatus(fileSystem, gitClient);
					});

					break;
				}
				case 'pop':
				case 'apply': {
					const stashEntries = await gitClient.listEphemeralReferences();
					const stashReferences = stashEntries.filter((r) => r.name.startsWith('stash-')).toSorted((a, b) => b.name.localeCompare(a.name));

					const targetIndex = index ?? 0;
					if (targetIndex >= stashReferences.length) {
						throw new Error(`Stash entry @{${targetIndex}} not found`);
					}

					const stashReference = stashReferences[targetIndex];

					await withMounts(async () => {
						mount(PROJECT_ROOT, fsStub);
						const fileSystem = await import('node:fs/promises');

						// Materialize the stash commit's tree into the working directory
						const stashTree = await gitClient.materializeTree(`refs/ephemeral/${stashReference.name}`);
						await applyTree(fileSystem, PROJECT_ROOT, stashTree, (oid) => gitClient.getBlobContent(oid));

						gitStatus = await readGitStatus(fileSystem, gitClient);
					});

					if (action === 'pop') {
						await gitClient.deleteEphemeralReference(stashReference.name);
					}

					break;
				}
				case 'drop': {
					const stashEntries = await gitClient.listEphemeralReferences();
					const stashReferences = stashEntries.filter((r) => r.name.startsWith('stash-')).toSorted((a, b) => b.name.localeCompare(a.name));

					const targetIndex = index ?? 0;
					if (targetIndex >= stashReferences.length) {
						throw new Error(`Stash entry @{${targetIndex}} not found`);
					}

					await gitClient.deleteEphemeralReference(stashReferences[targetIndex].name);

					await withMounts(async () => {
						mount(PROJECT_ROOT, fsStub);
						const fileSystem = await import('node:fs/promises');
						gitStatus = await readGitStatus(fileSystem, gitClient);
					});

					break;
				}
				case 'clear': {
					const stashEntries = await gitClient.listEphemeralReferences();
					for (const entry of stashEntries.filter((r) => r.name.startsWith('stash-'))) {
						await gitClient.deleteEphemeralReference(entry.name);
					}

					await withMounts(async () => {
						mount(PROJECT_ROOT, fsStub);
						const fileSystem = await import('node:fs/promises');
						gitStatus = await readGitStatus(fileSystem, gitClient);
					});

					break;
				}
				// No default
			}

			return c.json({ success: true, gitStatus });
		} catch (error) {
			console.error('Git stash error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to perform stash operation';
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, errorMessage);
		}
	})

	/**
	 * GET /api/git/stash — List stash entries.
	 */
	.get('/git/stash', async (c) => {
		const gitClient = getGitClient(c);

		try {
			const ephemeralReferences = await gitClient.listEphemeralReferences();
			const stashReferences = ephemeralReferences
				.filter((r) => r.name.startsWith('stash-'))
				.toSorted((a, b) => b.name.localeCompare(a.name));

			// Get commit messages for each stash entry
			const entries = await Promise.all(
				stashReferences.map(async (reference, entryIndex) => {
					const log = await gitClient.getLog({ ref: `refs/ephemeral/${reference.name}`, depth: 1 });
					return {
						index: entryIndex,
						message: log[0]?.message ?? reference.name,
						objectId: reference.oid,
					};
				}),
			);

			return c.json({ entries });
		} catch (error) {
			console.error('Git stash list error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to list stash entries');
		}
	})

	// =========================================================================
	// Diff
	// =========================================================================

	/**
	 * GET /api/git/diff — Get before/after content for a working tree file.
	 */
	.get('/git/diff', zValidator('query', gitDiffQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const fsStub = c.get('fsStub');
		const { path: filePath } = c.req.valid('query');

		try {
			const { mount, withMounts } = await import('worker-fs-mount');
			let diff: GitFileDiff | undefined;

			await withMounts(async () => {
				mount(PROJECT_ROOT, fsStub);
				const fileSystem = await import('node:fs/promises');

				const committedTree = await gitClient.materializeTree('HEAD');
				const committedFile = committedTree.find((entry) => entry.path === filePath);

				// Get before content (from committed tree)
				let beforeContent = '';
				if (committedFile) {
					const content = await gitClient.getBlobContent(committedFile.oid);
					if (content) beforeContent = new TextDecoder().decode(content);
				}

				// Get after content (from working tree)
				let afterContent = '';
				let fileExistsOnDisk = false;
				try {
					const buffer = await fileSystem.readFile(`${PROJECT_ROOT}/${filePath}`);
					afterContent = typeof buffer === 'string' ? buffer : new TextDecoder().decode(new Uint8Array(buffer));
					fileExistsOnDisk = true;
				} catch {
					// File deleted
				}

				const status: GitFileDiff['status'] = committedFile ? (fileExistsOnDisk ? 'modified' : 'deleted') : 'added';

				diff = {
					path: filePath,
					status,
					hunks: [], // Hunks computed by the frontend's diff extension
					beforeContent,
					afterContent,
				};
			});

			return c.json({ diff });
		} catch (error) {
			console.error('Git diff error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get file diff');
		}
	})

	/**
	 * GET /api/git/diff/commit — Get files changed in a specific commit.
	 */
	.get('/git/diff/commit', zValidator('query', gitCommitDiffQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { objectId } = c.req.valid('query');

		try {
			// Get the commit's parent to diff against
			const log = await gitClient.getLog({ ref: objectId, depth: 2 });
			if (log.length === 0) throw new Error('Commit not found');

			const commit = log[0];
			const parentOid = commit.parentOids[0];

			let treeDiff;
			if (parentOid) {
				treeDiff = await gitClient.diffTrees(parentOid, objectId);
			} else {
				// Initial commit — all files are "added"
				const tree = await gitClient.materializeTree(objectId);
				treeDiff = tree.map((entry) => ({
					path: entry.path,
					status: 'added' as const,
					headOid: entry.oid,
				}));
			}

			const files: GitFileDiff[] = treeDiff.map((entry) => ({
				path: entry.path,
				status: entry.status,
				hunks: [],
			}));

			return c.json({ files });
		} catch (error) {
			console.error('Git commit diff error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get commit diff');
		}
	})

	/**
	 * GET /api/git/diff/file — Get before/after content for a file at a specific commit.
	 */
	.get('/git/diff/file', zValidator('query', gitFileDiffAtCommitQuerySchema), async (c) => {
		const gitClient = getGitClient(c);
		const { objectId, path: filePath } = c.req.valid('query');

		try {
			const log = await gitClient.getLog({ ref: objectId, depth: 2 });
			if (log.length === 0) throw new Error('Commit not found');

			const commit = log[0];
			const parentOid = commit.parentOids[0];

			// Get file content at the commit
			const commitTree = await gitClient.materializeTree(objectId);
			const commitFile = commitTree.find((entry) => entry.path === filePath);
			let afterContent = '';
			if (commitFile) {
				const content = await gitClient.getBlobContent(commitFile.oid);
				if (content) afterContent = new TextDecoder().decode(content);
			}

			// Get file content at the parent
			let beforeContent = '';
			let parentFile: (typeof commitTree)[number] | undefined;
			if (parentOid) {
				const parentTree = await gitClient.materializeTree(parentOid);
				parentFile = parentTree.find((entry) => entry.path === filePath);
				if (parentFile) {
					const content = await gitClient.getBlobContent(parentFile.oid);
					if (content) beforeContent = new TextDecoder().decode(content);
				}
			}

			let status: GitFileDiff['status'];
			if (commitFile) {
				status = parentOid && parentFile ? 'modified' : 'added';
			} else {
				status = 'deleted';
			}

			const diff: GitFileDiff = {
				path: filePath,
				status,
				hunks: [],
				beforeContent,
				afterContent,
			};

			return c.json({ diff });
		} catch (error) {
			console.error('Git file diff at commit error:', error);
			throw httpError(HttpErrorCode.GIT_OPERATION_FAILED, 'Failed to get file diff at commit');
		}
	});

export type GitRoutes = typeof gitRoutes;
