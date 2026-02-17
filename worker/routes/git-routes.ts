/**
 * Git operation routes.
 * Handles local git operations: status, staging, commits, branches, tags, stash, and diffs.
 * All operations are local-only — no remote operations (clone, push, pull, fetch).
 *
 * All git operations are delegated to the Durable Object (ExpiringFilesystem)
 * via RPC. This eliminates the cross-request I/O race condition caused by
 * `isomorphic-git`'s module-level `AsyncLock` — the DO is single-threaded
 * with input/output gates, so only one git operation executes at a time.
 */

import { zValidator } from '@hono/zod-validator';
import { Hono } from 'hono';

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

import type { AppEnvironment } from '../types';

// =============================================================================
// Routes
// =============================================================================

export const gitRoutes = new Hono<AppEnvironment>()

	// =========================================================================
	// Status
	// =========================================================================

	/**
	 * GET /api/git/status — Get the status of all changed files.
	 */
	.get('/git/status', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const result = await fsStub.gitStatus();
			// Spread entries to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ ...result, entries: [...result.entries] });
		} catch (error) {
			console.error('Git status error:', error);
			return c.json({ error: 'Failed to get git status' }, 500);
		}
	})

	// =========================================================================
	// Staging
	// =========================================================================

	/**
	 * POST /api/git/stage — Stage files for commit.
	 */
	.post('/git/stage', zValidator('json', gitStageSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { paths } = c.req.valid('json');

		try {
			const result = await fsStub.gitStage(paths);
			return c.json(result);
		} catch (error) {
			console.error('Git stage error:', error);
			return c.json({ error: 'Failed to stage files' }, 500);
		}
	})

	/**
	 * POST /api/git/unstage — Unstage files.
	 */
	.post('/git/unstage', zValidator('json', gitStageSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { paths } = c.req.valid('json');

		try {
			const result = await fsStub.gitUnstage(paths);
			return c.json(result);
		} catch (error) {
			console.error('Git unstage error:', error);
			return c.json({ error: 'Failed to unstage files' }, 500);
		}
	})

	/**
	 * POST /api/git/stage-all — Stage all changed files.
	 */
	.post('/git/stage-all', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const result = await fsStub.gitStageAll();
			return c.json(result);
		} catch (error) {
			console.error('Git stage-all error:', error);
			return c.json({ error: 'Failed to stage all files' }, 500);
		}
	})

	/**
	 * POST /api/git/unstage-all — Unstage all files.
	 */
	.post('/git/unstage-all', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const result = await fsStub.gitUnstageAll();
			return c.json(result);
		} catch (error) {
			console.error('Git unstage-all error:', error);
			return c.json({ error: 'Failed to unstage all files' }, 500);
		}
	})

	/**
	 * POST /api/git/discard — Discard changes for a file.
	 */
	.post('/git/discard', zValidator('json', gitDiscardSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { path } = c.req.valid('json');

		try {
			const result = await fsStub.gitDiscard(path);
			return c.json(result);
		} catch (error) {
			console.error('Git discard error:', error);
			return c.json({ error: 'Failed to discard changes' }, 500);
		}
	})

	/**
	 * POST /api/git/discard-all — Discard all working directory changes.
	 */
	.post('/git/discard-all', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const result = await fsStub.gitDiscardAll();
			return c.json(result);
		} catch (error) {
			console.error('Git discard-all error:', error);
			return c.json({ error: 'Failed to discard all changes' }, 500);
		}
	})

	// =========================================================================
	// Commits
	// =========================================================================

	/**
	 * POST /api/git/commit — Create a commit with the currently staged changes.
	 */
	.post('/git/commit', zValidator('json', gitCommitSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { message, amend } = c.req.valid('json');

		try {
			const result = await fsStub.gitCommit(message, { amend });
			return c.json(result);
		} catch (error) {
			console.error('Git commit error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create commit';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * GET /api/git/log — Get commit history.
	 */
	.get('/git/log', zValidator('query', gitLogQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { reference, depth } = c.req.valid('query');

		try {
			const commits = await fsStub.gitLog({ reference, depth });
			// Spread to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ commits: [...commits] });
		} catch (error) {
			console.error('Git log error:', error);
			return c.json({ error: 'Failed to get git log' }, 500);
		}
	})

	/**
	 * GET /api/git/log/graph — Get commit history with graph layout data.
	 */
	.get('/git/log/graph', zValidator('query', gitGraphQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { maxCount } = c.req.valid('query');

		try {
			const commits = await fsStub.gitLog({ depth: maxCount ?? 100 });
			// Spread to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ commits: [...commits] });
		} catch (error) {
			console.error('Git graph error:', error);
			return c.json({ error: 'Failed to get git graph' }, 500);
		}
	})

	// =========================================================================
	// Branches
	// =========================================================================

	/**
	 * GET /api/git/branches — List all branches.
	 */
	.get('/git/branches', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const result = await fsStub.gitBranches();
			// Spread branches to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ ...result, branches: [...result.branches] });
		} catch (error) {
			console.error('Git branches error:', error);
			return c.json({ error: 'Failed to list branches' }, 500);
		}
	})

	/**
	 * POST /api/git/branch — Create a new branch.
	 */
	.post('/git/branch', zValidator('json', gitBranchSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { name, checkout } = c.req.valid('json');

		try {
			const result = await fsStub.gitCreateBranch(name, checkout);
			return c.json(result);
		} catch (error) {
			console.error('Git create branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create branch';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * DELETE /api/git/branch — Delete a branch.
	 */
	.delete('/git/branch', zValidator('query', gitBranchNameQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { name } = c.req.valid('query');

		try {
			const result = await fsStub.gitDeleteBranch(name);
			return c.json(result);
		} catch (error) {
			console.error('Git delete branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to delete branch';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * POST /api/git/branch/rename — Rename a branch.
	 */
	.post('/git/branch/rename', zValidator('json', gitBranchRenameSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { oldName, newName } = c.req.valid('json');

		try {
			const result = await fsStub.gitRenameBranch(oldName, newName);
			return c.json(result);
		} catch (error) {
			console.error('Git rename branch error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to rename branch';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * POST /api/git/checkout — Checkout a branch or ref.
	 */
	.post('/git/checkout', zValidator('json', gitCheckoutSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { reference } = c.req.valid('json');

		try {
			const result = await fsStub.gitCheckout(reference);
			return c.json(result);
		} catch (error) {
			console.error('Git checkout error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to checkout';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * POST /api/git/merge — Merge a branch into the current branch.
	 */
	.post('/git/merge', zValidator('json', gitMergeSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { branch } = c.req.valid('json');

		try {
			const result = await fsStub.gitMerge(branch);
			return c.json(result);
		} catch (error) {
			console.error('Git merge error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to merge';
			return c.json({ error: errorMessage }, 500);
		}
	})

	// =========================================================================
	// Tags
	// =========================================================================

	/**
	 * GET /api/git/tags — List all tags.
	 */
	.get('/git/tags', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const tags = await fsStub.gitTags();
			// Spread to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ tags: [...tags] });
		} catch (error) {
			console.error('Git tags error:', error);
			return c.json({ error: 'Failed to list tags' }, 500);
		}
	})

	/**
	 * POST /api/git/tag — Create a tag.
	 */
	.post('/git/tag', zValidator('json', gitTagSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { name, reference } = c.req.valid('json');

		try {
			const result = await fsStub.gitCreateTag(name, reference);
			return c.json(result);
		} catch (error) {
			console.error('Git create tag error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to create tag';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * DELETE /api/git/tag — Delete a tag.
	 */
	.delete('/git/tag', zValidator('query', gitTagNameQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { name } = c.req.valid('query');

		try {
			const result = await fsStub.gitDeleteTag(name);
			return c.json(result);
		} catch (error) {
			console.error('Git delete tag error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to delete tag';
			return c.json({ error: errorMessage }, 500);
		}
	})

	// =========================================================================
	// Stash
	// =========================================================================

	/**
	 * POST /api/git/stash — Perform a stash operation.
	 */
	.post('/git/stash', zValidator('json', gitStashSchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { action, index, message } = c.req.valid('json');

		try {
			const result = await fsStub.gitStash(action, { index, message });
			return c.json(result);
		} catch (error) {
			console.error('Git stash error:', error);
			const errorMessage = error instanceof Error ? error.message : 'Failed to perform stash operation';
			return c.json({ error: errorMessage }, 500);
		}
	})

	/**
	 * GET /api/git/stash — List stash entries.
	 */
	.get('/git/stash', async (c) => {
		const fsStub = c.get('fsStub');

		try {
			const entries = await fsStub.gitStashList();
			// Spread to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ entries: [...entries] });
		} catch (error) {
			console.error('Git stash list error:', error);
			return c.json({ error: 'Failed to list stash entries' }, 500);
		}
	})

	// =========================================================================
	// Diff
	// =========================================================================

	/**
	 * GET /api/git/diff — Get the diff for a single file.
	 */
	.get('/git/diff', zValidator('query', gitDiffQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { path } = c.req.valid('query');

		try {
			const diff = await fsStub.gitDiff(path);
			return c.json({ diff });
		} catch (error) {
			console.error('Git diff error:', error);
			return c.json({ error: 'Failed to get file diff' }, 500);
		}
	})

	/**
	 * GET /api/git/diff/commit — Get the diff for a specific commit.
	 */
	.get('/git/diff/commit', zValidator('query', gitCommitDiffQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { objectId } = c.req.valid('query');

		try {
			const files = await fsStub.gitDiffCommit(objectId);
			// Spread to convert Serialized<T[]> from DO RPC into a plain array
			return c.json({ files: [...files] });
		} catch (error) {
			console.error('Git commit diff error:', error);
			return c.json({ error: 'Failed to get commit diff' }, 500);
		}
	})

	/**
	 * GET /api/git/diff/file — Get the before/after content for a file at a specific commit.
	 */
	.get('/git/diff/file', zValidator('query', gitFileDiffAtCommitQuerySchema), async (c) => {
		const fsStub = c.get('fsStub');
		const { objectId, path } = c.req.valid('query');

		try {
			const diff = await fsStub.gitDiffFileAtCommit(objectId, path);
			return c.json({ diff });
		} catch (error) {
			console.error('Git file diff at commit error:', error);
			return c.json({ error: 'Failed to get file diff at commit' }, 500);
		}
	});

export type GitRoutes = typeof gitRoutes;
