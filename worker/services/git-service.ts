/**
 * Git Service.
 * Wraps isomorphic-git to provide local git operations for the IDE.
 * All operations are local-only — no remote operations (clone, push, pull, fetch).
 */

import fs from 'node:fs/promises';

import git from 'isomorphic-git';

import type {
	GitAuthor,
	GitBranchInfo,
	GitCommitEntry,
	GitDiffHunk,
	GitDiffLine,
	GitFileDiff,
	GitFileStatus,
	GitMergeResult,
	GitStashEntry,
	GitStatusEntry,
} from '@shared/types';

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_AUTHOR = { name: 'IDE User', email: 'user@example.com' };

/**
 * Normalize a filesystem path by resolving `.` and `..` segments.
 *
 * isomorphic-git constructs paths like `${dir}/${filepath}` where `filepath`
 * can be `.` (root walk entry), producing paths like `/project/.` which
 * worker-fs-mount cannot resolve. This function collapses such segments.
 */
function normalizeFsPath(filePath: string): string {
	const parts = filePath.split('/');
	const resolved: string[] = [];
	for (const part of parts) {
		if (part === '.' || part === '') {
			// Skip `.` and empty segments (from leading/consecutive slashes)
			continue;
		}
		if (part === '..') {
			resolved.pop();
		} else {
			resolved.push(part);
		}
	}
	return '/' + resolved.join('/');
}

/**
 * Wrap an fs argument so that the first string parameter (the path) of each
 * method is normalized before forwarding to the real implementation.
 *
 * This is needed because isomorphic-git constructs paths like `/project/.`
 * which worker-fs-mount's path matching does not handle correctly.
 */
function createNormalizedFs(baseFs: typeof fs): typeof fs {
	return new Proxy(baseFs, {
		get(target, property, receiver) {
			const value = Reflect.get(target, property, receiver);
			if (typeof value !== 'function') return value;

			// isomorphic-git calls mkdir without { recursive: true }, but
			// worker-fs-mount's Durable Object filesystem needs it to create
			// intermediate directories (e.g. .git/objects/54/).
			if (property === 'mkdir') {
				return (path: unknown, options?: unknown) => {
					const normalizedPath = typeof path === 'string' ? normalizeFsPath(path) : path;
					const options_ = typeof options === 'object' && options !== undefined ? { ...options, recursive: true } : { recursive: true };
					return Reflect.apply(value, target, [normalizedPath, options_]);
				};
			}

			// Wrap every other function to normalize the first string argument (the path)
			const wrapped = (...arguments_: unknown[]) => {
				if (typeof arguments_[0] === 'string') {
					arguments_[0] = normalizeFsPath(arguments_[0]);
				}
				return Reflect.apply(value, target, arguments_);
			};
			return wrapped;
		},
	});
}

/**
 * Create a fresh fs object for isomorphic-git.
 *
 * IMPORTANT: This must NOT be a module-level singleton. isomorphic-git's
 * internal `FileSystem` class caches bound method references and sets
 * `_original_unwrapped_fs` on the input object. If shared across Cloudflare
 * Worker request contexts, this causes stale I/O references and cross-context
 * promise contamination via the module-level `AsyncLock`.
 *
 * Creating a fresh object per `GitService` instance ensures each request gets
 * clean method bindings tied to the current `withMounts` scope.
 */
function createGitFs(): { promises: typeof fs } {
	return { promises: createNormalizedFs(fs) };
}

// =============================================================================
// Status Matrix Interpretation
// =============================================================================

/**
 * Interpret isomorphic-git statusMatrix row into a human-friendly status.
 *
 * statusMatrix returns [filepath, HEAD, WORKDIR, STAGE] where:
 * - HEAD:    0 = absent, 1 = present
 * - WORKDIR: 0 = absent, 1 = identical to HEAD, 2 = different from HEAD
 * - STAGE:   0 = absent, 1 = identical to HEAD, 2 = identical to WORKDIR, 3 = different from both
 */
function interpretStatus(head: number, workdir: number, stage: number): { status: GitFileStatus; staged: boolean } {
	// New file (not in HEAD)
	if (head === 0) {
		if (stage === 0) return { status: 'untracked', staged: false };
		if (stage === 2) return { status: 'untracked-staged', staged: true };
		if (stage === 3) return { status: 'untracked-partially-staged', staged: true };
	}

	// Existing file (in HEAD)
	if (head === 1) {
		// Unmodified
		if (workdir === 1 && stage === 1) return { status: 'unmodified', staged: false };

		// Modified
		if (workdir === 2 && stage === 1) return { status: 'modified', staged: false };
		if (workdir === 2 && stage === 2) return { status: 'modified-staged', staged: true };
		if (workdir === 2 && stage === 3) return { status: 'modified-partially-staged', staged: true };

		// Deleted
		if (workdir === 0 && stage === 1) return { status: 'deleted', staged: false };
		if (workdir === 0 && stage === 0) return { status: 'deleted-staged', staged: true };
	}

	// Fallback for edge cases
	return { status: 'unmodified', staged: false };
}

// =============================================================================
// Git Service
// =============================================================================

export class GitService {
	private readonly directory: string;
	private readonly gitFs: { promises: typeof fs };

	constructor(projectRoot: string) {
		this.directory = projectRoot;
		this.gitFs = createGitFs();
	}

	// =========================================================================
	// Repository
	// =========================================================================

	/**
	 * Initialize a new git repository.
	 */
	async initialize(defaultBranch = 'main'): Promise<void> {
		await git.init({
			fs: this.gitFs,
			dir: this.directory,
			defaultBranch,
		});
	}

	/**
	 * Check if the project has a git repository.
	 */
	async isInitialized(): Promise<boolean> {
		try {
			await fs.access(`${this.directory}/.git/HEAD`);
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Check if the repository has at least one commit.
	 *
	 * After `git init` but before the first commit, HEAD points to a ref
	 * (e.g. `refs/heads/main`) that doesn't exist yet. Operations like
	 * `statusMatrix` and `currentBranch` fail with `NotFoundError` in this
	 * state. Callers should check this before running such operations.
	 */
	async hasCommits(): Promise<boolean> {
		try {
			const heads = await fs.readdir(`${this.directory}/.git/refs/heads`);
			return heads.length > 0;
		} catch {
			return false;
		}
	}

	/**
	 * Set a git config value (e.g. user.name, user.email).
	 */
	async setConfig(path: string, value: string): Promise<void> {
		await git.setConfig({
			fs: this.gitFs,
			dir: this.directory,
			path,
			value,
		});
	}

	// =========================================================================
	// Status
	// =========================================================================

	/**
	 * Get the status of all files in the working tree.
	 * Returns only files that have changed (excludes unmodified).
	 *
	 * Returns an empty array if the repository has no commits yet
	 * (e.g. during deferred initialization).
	 */
	async getStatus(): Promise<GitStatusEntry[]> {
		// statusMatrix requires at least one commit (HEAD must resolve).
		// During deferred init, the repo may exist but have no commits yet.
		if (!(await this.hasCommits())) {
			return [];
		}

		const matrix = await git.statusMatrix({
			fs: this.gitFs,
			dir: this.directory,
		});

		const entries: GitStatusEntry[] = [];

		for (const [filepath, head, workdir, stage] of matrix) {
			const { status, staged } = interpretStatus(head, workdir, stage);

			// Skip unmodified files
			if (status === 'unmodified') continue;

			entries.push({
				path: filepath,
				status,
				staged,
				headStatus: head,
				workdirStatus: workdir,
				stageStatus: stage,
			});
		}

		return entries;
	}

	// =========================================================================
	// Staging
	// =========================================================================

	/**
	 * Stage files for commit (git add).
	 */
	async stage(filepaths: string[]): Promise<void> {
		for (const filepath of filepaths) {
			// Check if the file exists in workdir; if not, it's a delete — use remove
			try {
				await fs.access(`${this.directory}/${filepath}`);
				await git.add({ fs: this.gitFs, dir: this.directory, filepath });
			} catch {
				// File doesn't exist in workdir — stage the deletion
				await git.remove({ fs: this.gitFs, dir: this.directory, filepath });
			}
		}
	}

	/**
	 * Unstage files (git reset -- <filepath>).
	 */
	async unstage(filepaths: string[]): Promise<void> {
		for (const filepath of filepaths) {
			await git.resetIndex({ fs: this.gitFs, dir: this.directory, filepath });
		}
	}

	/**
	 * Stage all changed files.
	 */
	async stageAll(): Promise<void> {
		const matrix = await git.statusMatrix({ fs: this.gitFs, dir: this.directory });

		for (const [filepath, head, workdir, stage] of matrix) {
			const { status } = interpretStatus(head, workdir, stage);
			if (status === 'unmodified') continue;

			await (workdir === 0
				? git.remove({ fs: this.gitFs, dir: this.directory, filepath })
				: git.add({ fs: this.gitFs, dir: this.directory, filepath }));
		}
	}

	/**
	 * Unstage all staged files.
	 */
	async unstageAll(): Promise<void> {
		const matrix = await git.statusMatrix({ fs: this.gitFs, dir: this.directory });

		for (const [filepath, head, _workdir, stage] of matrix) {
			const { staged } = interpretStatus(head, _workdir, stage);
			if (staged) {
				await git.resetIndex({ fs: this.gitFs, dir: this.directory, filepath });
			}
		}
	}

	/**
	 * Discard working directory changes for a file (checkout from HEAD).
	 */
	async discardChanges(filepath: string): Promise<void> {
		await git.checkout({
			fs: this.gitFs,
			dir: this.directory,
			force: true,
			filepaths: [filepath],
		});
		// Also reset the index for this file
		await git.resetIndex({ fs: this.gitFs, dir: this.directory, filepath });
	}

	/**
	 * Discard all working directory changes.
	 */
	async discardAllChanges(): Promise<void> {
		await git.checkout({
			fs: this.gitFs,
			dir: this.directory,
			force: true,
			filepaths: ['.'],
		});
	}

	// =========================================================================
	// Commits
	// =========================================================================

	/**
	 * Create a commit with the currently staged changes.
	 */
	async commit(message: string, options?: { amend?: boolean; author?: { name: string; email: string } }): Promise<string> {
		const author = options?.author ?? DEFAULT_AUTHOR;

		const objectId = await git.commit({
			fs: this.gitFs,
			dir: this.directory,
			message,
			author: {
				name: author.name,
				email: author.email,
			},
			amend: options?.amend,
		});

		return objectId;
	}

	/**
	 * Get commit history.
	 */
	async log(options?: { depth?: number; reference?: string }): Promise<GitCommitEntry[]> {
		const commits = await git.log({
			fs: this.gitFs,
			dir: this.directory,
			depth: options?.depth ?? 50,
			ref: options?.reference ?? 'HEAD',
		});

		return commits.map((entry) => ({
			objectId: entry.oid,
			abbreviatedObjectId: entry.oid.slice(0, 7),
			message: entry.commit.message,
			author: {
				name: entry.commit.author.name,
				email: entry.commit.author.email,
				timestamp: entry.commit.author.timestamp,
			},
			parentObjectIds: entry.commit.parent,
		}));
	}

	// =========================================================================
	// Branches
	// =========================================================================

	/**
	 * List all local branches.
	 */
	async listBranches(): Promise<GitBranchInfo[]> {
		const branches = await git.listBranches({ fs: this.gitFs, dir: this.directory });
		const current = await this.getCurrentBranch();

		return branches.map((name) => ({
			name,
			isCurrent: name === current,
		}));
	}

	/**
	 * Get the current branch name.
	 *
	 * Returns `undefined` if the repository has no commits yet (HEAD
	 * points to a non-existent ref).
	 */
	async getCurrentBranch(): Promise<string | undefined> {
		// Before the first commit, HEAD references a branch that doesn't
		// exist yet. isomorphic-git throws NotFoundError in this case.
		if (!(await this.hasCommits())) {
			// Read the default branch name from HEAD directly
			try {
				const head = await fs.readFile(`${this.directory}/.git/HEAD`, 'utf8');
				const match = /ref: refs\/heads\/(.+)/.exec(head.trim());
				return match?.[1];
			} catch {
				return undefined;
			}
		}

		const branch = await git.currentBranch({
			fs: this.gitFs,
			dir: this.directory,
			fullname: false,
			test: true,
		});
		return branch ?? undefined;
	}

	/**
	 * Create a new branch.
	 */
	async createBranch(name: string, shouldCheckout = false): Promise<void> {
		await git.branch({
			fs: this.gitFs,
			dir: this.directory,
			ref: name,
			checkout: shouldCheckout,
		});
	}

	/**
	 * Delete a branch.
	 */
	async deleteBranch(name: string): Promise<void> {
		await git.deleteBranch({
			fs: this.gitFs,
			dir: this.directory,
			ref: name,
		});
	}

	/**
	 * Rename a branch.
	 */
	async renameBranch(oldName: string, newName: string): Promise<void> {
		await git.renameBranch({
			fs: this.gitFs,
			dir: this.directory,
			ref: newName,
			oldref: oldName,
		});
	}

	/**
	 * Checkout a branch or ref.
	 */
	async checkout(reference: string): Promise<void> {
		await git.checkout({
			fs: this.gitFs,
			dir: this.directory,
			ref: reference,
			force: false,
		});
	}

	/**
	 * Merge a branch into the current branch.
	 */
	async merge(theirBranch: string, author?: GitAuthor): Promise<GitMergeResult> {
		const mergeAuthor = author ?? DEFAULT_AUTHOR;
		try {
			const result = await git.merge({
				fs: this.gitFs,
				dir: this.directory,
				theirs: theirBranch,
				author: {
					name: mergeAuthor.name,
					email: mergeAuthor.email,
				},
				abortOnConflict: false,
			});

			return {
				objectId: result.oid,
				alreadyMerged: result.alreadyMerged,
				fastForward: result.fastForward,
			};
		} catch (error: unknown) {
			// Check for merge conflict
			if (error instanceof Error && error.constructor.name === 'MergeConflictError') {
				const conflicts = 'data' in error && Array.isArray(error.data) ? error.data : [];
				return {
					conflicts: conflicts.map(String),
				};
			}
			throw error;
		}
	}

	// =========================================================================
	// Tags
	// =========================================================================

	/**
	 * List all tags.
	 */
	async listTags(): Promise<string[]> {
		return git.listTags({ fs: this.gitFs, dir: this.directory });
	}

	/**
	 * Create a lightweight tag.
	 */
	async createTag(name: string, reference?: string): Promise<void> {
		await git.tag({
			fs: this.gitFs,
			dir: this.directory,
			ref: name,
			object: reference,
		});
	}

	/**
	 * Delete a tag.
	 */
	async deleteTag(name: string): Promise<void> {
		await git.deleteTag({
			fs: this.gitFs,
			dir: this.directory,
			ref: name,
		});
	}

	// =========================================================================
	// Stash
	// =========================================================================

	/**
	 * Perform a stash operation.
	 */
	async stashPush(message?: string): Promise<void> {
		await git.stash({
			fs: this.gitFs,
			dir: this.directory,
			op: 'push',
			message,
		});
	}

	async stashPop(index?: number): Promise<void> {
		await git.stash({
			fs: this.gitFs,
			dir: this.directory,
			op: 'pop',
			refIdx: index,
		});
	}

	async stashApply(index?: number): Promise<void> {
		await git.stash({
			fs: this.gitFs,
			dir: this.directory,
			op: 'apply',
			refIdx: index,
		});
	}

	async stashDrop(index?: number): Promise<void> {
		await git.stash({
			fs: this.gitFs,
			dir: this.directory,
			op: 'drop',
			refIdx: index,
		});
	}

	async stashList(): Promise<GitStashEntry[]> {
		try {
			const result = await git.stash({
				fs: this.gitFs,
				dir: this.directory,
				op: 'list',
			});

			// stash list returns a string with newline-separated entries or void
			if (!result) return [];

			const lines = result.split('\n').filter(Boolean);
			return lines.map((line, index) => ({
				index,
				message: line,
				objectId: '',
			}));
		} catch {
			return [];
		}
	}

	async stashClear(): Promise<void> {
		await git.stash({
			fs: this.gitFs,
			dir: this.directory,
			op: 'clear',
		});
	}

	// =========================================================================
	// Diff
	// =========================================================================

	/**
	 * Get a diff for a single file between working directory and HEAD.
	 */
	async diffFile(filepath: string): Promise<GitFileDiff> {
		let headContent = '';
		let workdirContent = '';
		let fileStatus: 'modified' | 'added' | 'deleted' = 'modified';

		// Try to read HEAD version
		try {
			const commitOid = await git.resolveRef({ fs: this.gitFs, dir: this.directory, ref: 'HEAD' });
			const { blob } = await git.readBlob({
				fs: this.gitFs,
				dir: this.directory,
				oid: commitOid,
				filepath,
			});
			headContent = new TextDecoder().decode(blob);
		} catch {
			// File doesn't exist in HEAD — it's a new file
			fileStatus = 'added';
		}

		// Try to read working directory version
		try {
			workdirContent = await fs.readFile(`${this.directory}/${filepath}`, 'utf8');
		} catch {
			// File doesn't exist in workdir — it's deleted
			fileStatus = 'deleted';
		}

		const hunks = computeDiffHunks(headContent, workdirContent);

		return { path: filepath, status: fileStatus, hunks, beforeContent: headContent, afterContent: workdirContent };
	}

	/**
	 * Get the diff for a specific commit compared to its parent.
	 */
	async diffCommit(objectId: string): Promise<GitFileDiff[]> {
		const commit = await git.readCommit({
			fs: this.gitFs,
			dir: this.directory,
			oid: objectId,
		});

		const parentOid = commit.commit.parent[0];
		const diffs: GitFileDiff[] = [];

		// Walk both trees to find differences
		const trees = parentOid ? [git.TREE({ ref: parentOid }), git.TREE({ ref: objectId })] : [git.TREE({ ref: objectId })];

		await git.walk({
			fs: this.gitFs,
			dir: this.directory,
			trees,
			map: async (filepath, entries) => {
				if (filepath === '.') return;
				if (!entries) return;

				if (parentOid) {
					// Compare parent tree vs commit tree
					const [parentEntry, commitEntry] = entries;
					const parentOidValue = parentEntry ? await parentEntry.oid() : undefined;
					const commitOidValue = commitEntry ? await commitEntry.oid() : undefined;

					if (parentOidValue === commitOidValue) return;

					const parentType = parentEntry ? await parentEntry.type() : undefined;
					const commitType = commitEntry ? await commitEntry.type() : undefined;

					// Skip directories
					if (parentType === 'tree' || commitType === 'tree') return;

					let status: 'modified' | 'added' | 'deleted' = 'modified';
					if (!parentOidValue) status = 'added';
					else if (!commitOidValue) status = 'deleted';

					diffs.push({ path: filepath, status, hunks: [] });
				} else {
					// No parent — all files are "added"
					const [entry] = entries;
					if (!entry) return;
					const entryType = await entry.type();
					if (entryType === 'tree') return;

					diffs.push({ path: filepath, status: 'added', hunks: [] });
				}

				return;
			},
		});

		return diffs;
	}

	/**
	 * Get the before/after content for a single file at a specific commit.
	 * "before" = content at the commit's parent, "after" = content at the commit.
	 */
	async diffFileAtCommit(objectId: string, filepath: string): Promise<GitFileDiff> {
		const commit = await git.readCommit({
			fs: this.gitFs,
			dir: this.directory,
			oid: objectId,
		});

		const parentOid = commit.commit.parent[0];
		let beforeContent = '';
		let afterContent = '';
		let fileStatus: 'modified' | 'added' | 'deleted' = 'modified';

		// Read content at commit
		try {
			const { blob } = await git.readBlob({
				fs: this.gitFs,
				dir: this.directory,
				oid: objectId,
				filepath,
			});
			afterContent = new TextDecoder().decode(blob);
		} catch {
			// File doesn't exist at this commit — it was deleted
			fileStatus = 'deleted';
		}

		// Read content at parent commit
		if (parentOid) {
			try {
				const { blob } = await git.readBlob({
					fs: this.gitFs,
					dir: this.directory,
					oid: parentOid,
					filepath,
				});
				beforeContent = new TextDecoder().decode(blob);
			} catch {
				// File doesn't exist in parent — it was added
				if (fileStatus !== 'deleted') {
					fileStatus = 'added';
				}
			}
		} else {
			// No parent (initial commit) — everything is "added"
			fileStatus = 'added';
		}

		const hunks = computeDiffHunks(beforeContent, afterContent);

		return { path: filepath, status: fileStatus, hunks, beforeContent, afterContent };
	}
}

// =============================================================================
// Diff Computation
// =============================================================================

/**
 * Compute diff hunks between two strings using a simple line-by-line diff.
 * This is a basic implementation — for production use, consider using the `diff` package.
 */
function computeDiffHunks(oldContent: string, newContent: string): GitDiffHunk[] {
	const oldLines = oldContent.split('\n');
	const newLines = newContent.split('\n');

	// Simple LCS-based diff
	const hunks: GitDiffHunk[] = [];
	const diffLines: GitDiffLine[] = [];

	// Use a basic algorithm: compute edit script via forward scan
	let oldIndex = 0;
	let newIndex = 0;

	while (oldIndex < oldLines.length || newIndex < newLines.length) {
		if (oldIndex < oldLines.length && newIndex < newLines.length && oldLines[oldIndex] === newLines[newIndex]) {
			diffLines.push({ type: 'context', content: oldLines[oldIndex] });
			oldIndex++;
			newIndex++;
		} else if (newIndex < newLines.length && (oldIndex >= oldLines.length || !oldLines.includes(newLines[newIndex]))) {
			diffLines.push({ type: 'add', content: newLines[newIndex] });
			newIndex++;
		} else if (oldIndex < oldLines.length) {
			diffLines.push({ type: 'remove', content: oldLines[oldIndex] });
			oldIndex++;
		}
	}

	// Group consecutive non-context lines into hunks with surrounding context
	if (diffLines.some((line) => line.type !== 'context')) {
		const contextSize = 3;
		let hunkStart = -1;
		let currentHunkLines: GitDiffLine[] = [];
		let oldStart = 1;
		let newStart = 1;
		let oldCount = 0;
		let newCount = 0;

		for (let index = 0; index < diffLines.length; index++) {
			const line = diffLines[index];
			const isChange = line.type !== 'context';

			if (isChange) {
				if (hunkStart === -1) {
					// Start a new hunk — include preceding context
					const contextStart = Math.max(0, index - contextSize);
					hunkStart = contextStart;

					// Calculate starting line numbers
					let oldLineNumber = 1;
					let newLineNumber = 1;
					for (let index_ = 0; index_ < contextStart; index_++) {
						if (diffLines[index_].type !== 'add') oldLineNumber++;
						if (diffLines[index_].type !== 'remove') newLineNumber++;
					}
					oldStart = oldLineNumber;
					newStart = newLineNumber;
					oldCount = 0;
					newCount = 0;
					currentHunkLines = [];

					// Add preceding context
					for (let index_ = contextStart; index_ < index; index_++) {
						currentHunkLines.push(diffLines[index_]);
						oldCount++;
						newCount++;
					}
				}

				currentHunkLines.push(line);
				if (line.type === 'remove') oldCount++;
				else if (line.type === 'add') newCount++;
			} else if (hunkStart !== -1) {
				// Check if we should close the hunk (too many context lines)
				let nextChangeIndex = -1;
				for (let index_ = index; index_ < diffLines.length; index_++) {
					if (diffLines[index_].type !== 'context') {
						nextChangeIndex = index_;
						break;
					}
				}

				if (nextChangeIndex === -1 || nextChangeIndex - index > contextSize * 2) {
					// Close the hunk — add trailing context
					const trailingEnd = Math.min(diffLines.length, index + contextSize);
					for (let index_ = index; index_ < trailingEnd; index_++) {
						currentHunkLines.push(diffLines[index_]);
						oldCount++;
						newCount++;
					}

					hunks.push({
						oldStart,
						oldLines: oldCount,
						newStart,
						newLines: newCount,
						lines: currentHunkLines,
					});

					hunkStart = -1;
					currentHunkLines = [];
				} else {
					// Continue the hunk — this context is between two changes
					currentHunkLines.push(line);
					oldCount++;
					newCount++;
				}
			}
		}

		// Close any remaining hunk
		if (hunkStart !== -1 && currentHunkLines.length > 0) {
			hunks.push({
				oldStart,
				oldLines: oldCount,
				newStart,
				newLines: newCount,
				lines: currentHunkLines,
			});
		}
	}

	return hunks;
}
