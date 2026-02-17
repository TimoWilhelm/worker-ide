import { DurableObjectFilesystem } from 'durable-object-fs';
import { mount, withMounts } from 'worker-fs-mount';

import { PROJECT_EXPIRATION_DAYS } from '@shared/constants';

import { GitService } from '../services/git-service';

import type { GitBranchInfo, GitCommitEntry, GitFileDiff, GitMergeResult, GitStashEntry, GitStatusEntry } from '@shared/types';

/**
 * Project expiration duration in milliseconds.
 * Projects unused for this duration will be automatically deleted.
 */
const PROJECT_EXPIRATION_MS = PROJECT_EXPIRATION_DAYS * 24 * 60 * 60 * 1000;

const PROJECT_ROOT = '/project';

/**
 * Entries to skip when staging files for the initial git commit.
 * These are internal sentinel/metadata files that should not be tracked.
 */
const GIT_INIT_SKIP_ENTRIES = new Set(['.initialized', '.project-meta.json', '.template', '.agent', '.git']);

/**
 * Content for `.git/info/exclude` — git's built-in local-only ignore file.
 *
 * These IDE-internal files live on disk but should never appear in
 * `git status` or be staged/committed. Using `.git/info/exclude` instead
 * of `.gitignore` keeps them invisible to the user (`.git/` is already
 * hidden from file listings via `HIDDEN_ENTRIES`), and avoids leaking
 * platform implementation details into the user's working tree.
 */
const GIT_EXCLUDE_CONTENT = `# IDE platform files (managed automatically)
.initialized
.project-meta.json
.template
.agent
`;

/**
 * Recursively list all files in a project directory, returning paths
 * relative to `projectRoot` (without leading slash), suitable for
 * passing directly to `git.add`.
 *
 * Skips internal IDE files that should not be git-tracked.
 */
async function listAllProjectFiles(fileSystem: typeof import('node:fs/promises'), projectRoot: string, base = ''): Promise<string[]> {
	const files: string[] = [];
	const entries = await fileSystem.readdir(`${projectRoot}${base ? `/${base}` : ''}`, { withFileTypes: true });

	for (const entry of entries) {
		if (GIT_INIT_SKIP_ENTRIES.has(entry.name)) continue;

		const relativePath = base ? `${base}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			files.push(...(await listAllProjectFiles(fileSystem, projectRoot, relativePath)));
		} else {
			files.push(relativePath);
		}
	}

	return files;
}

// =============================================================================
// Response types for RPC methods
// =============================================================================

interface GitStatusResponse {
	entries: GitStatusEntry[];
	initialized: boolean;
}

interface GitBranchesResponse {
	branches: GitBranchInfo[];
	current: string | undefined;
}

interface GitMutationWithStatusResponse {
	success: boolean;
	gitStatus: GitStatusResponse;
}

interface GitCommitResponse {
	objectId: string;
	gitStatus: GitStatusResponse;
}

interface GitMergeWithStatusResponse extends GitMergeResult {
	gitStatus: GitStatusResponse;
}

interface GitCheckoutResponse {
	success: boolean;
	gitStatus: GitStatusResponse;
}

/**
 * Extended DurableObjectFilesystem that adds automatic expiration for unused projects
 * and git operations that run inside the DO's single-threaded context.
 *
 * Moving git operations into the DO eliminates the cross-request I/O race condition
 * caused by `isomorphic-git`'s module-level `AsyncLock`. DOs are single-threaded
 * with input/output gates — only one RPC call executes at a time, so the lock
 * can never have cross-request contention.
 *
 * Each git method follows the pattern:
 *   withMounts(() => { mount('/project', this); ... })
 * Inside the DO, `this` (ExpiringFilesystem extends DurableObjectFilesystem)
 * implements the `WorkerFilesystem` interface, so `mount('/project', this)`
 * works without any network hop — FS calls go directly to `this.stat()`,
 * `this.createReadStream()`, etc.
 */
export class ExpiringFilesystem extends DurableObjectFilesystem {
	// =========================================================================
	// Expiration
	// =========================================================================

	/**
	 * Refresh the expiration alarm. This should be called on every project access.
	 * Sets an alarm for PROJECT_EXPIRATION_MS from now.
	 */
	async refreshExpiration(): Promise<void> {
		await this.ctx.storage.deleteAlarm();

		const expirationTime = Date.now() + PROJECT_EXPIRATION_MS;
		await this.ctx.storage.setAlarm(expirationTime);
	}

	/**
	 * Get the current expiration time, if set.
	 * @returns The expiration timestamp in milliseconds, or null if no alarm is set
	 */
	async getExpirationTime(): Promise<number | null> {
		return await this.ctx.storage.getAlarm();
	}

	/**
	 * Alarm handler - called when the expiration alarm fires.
	 * Deletes all data in this Durable Object, effectively removing the project.
	 */
	async alarm(): Promise<void> {
		// Delete all data in this Durable Object
		await this.ctx.storage.deleteAll();
		console.log(`Project expired and deleted at ${new Date().toISOString()}`);
	}

	// =========================================================================
	// Git — Internal Helpers
	// =========================================================================

	/**
	 * Run a callback inside a `withMounts` scope with `/project` mounted to `this`.
	 * All git RPC methods use this to ensure FS operations go through the DO.
	 */
	private async withGitMount<T>(callback: () => Promise<T>): Promise<T> {
		return withMounts(async () => {
			mount(PROJECT_ROOT, this);
			return callback();
		});
	}

	/**
	 * Create a GitService pointed at the mounted project root.
	 * Must be called from within a `withGitMount` scope.
	 */
	private createGitService(): GitService {
		return new GitService(PROJECT_ROOT);
	}

	/**
	 * Read current git status. Used after mutations to return inline status.
	 */
	private async readStatusInline(gitService: GitService): Promise<GitStatusResponse> {
		try {
			const isInitialized = await gitService.isInitialized();
			if (!isInitialized) {
				return { entries: [], initialized: false };
			}
			const entries = await gitService.getStatus();
			return { entries, initialized: true };
		} catch (error) {
			console.error('Inline git status read failed:', error);
			return { entries: [], initialized: true };
		}
	}

	/**
	 * Broadcast a `git-status-changed` WebSocket message to all connected clients.
	 */
	private broadcastGitStatusChanged(): void {
		try {
			const projectId = this.ctx.id.toString();
			const coordinatorId = this.env.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
			const coordinatorStub = this.env.DO_PROJECT_COORDINATOR.get(coordinatorId);
			void coordinatorStub.sendMessage({ type: 'git-status-changed' });
		} catch {
			// Non-fatal
		}
	}

	// =========================================================================
	// Git — Initialization
	// =========================================================================

	/**
	 * Initialize a git repository with all existing files committed as "Initial commit".
	 *
	 * Handles:
	 * 1. Checking if already initialized (has branch refs)
	 * 2. Running `git init`
	 * 3. Writing `.git/info/exclude` for IDE-internal files
	 * 4. Staging all project files (skipping internal ones)
	 * 5. Creating the initial commit
	 * 6. Broadcasting `git-status-changed`
	 */
	async gitInit(): Promise<void> {
		await this.withGitMount(async () => {
			const fileSystem = await import('node:fs/promises');
			const gitService = this.createGitService();

			// Check if git is already fully initialized (has at least one commit).
			try {
				const heads = await fileSystem.readdir(`${PROJECT_ROOT}/.git/refs/heads`);
				if (heads.length > 0) {
					return; // Has branch refs — fully initialized
				}
			} catch {
				// No refs/heads directory — needs initialization
			}

			await gitService.initialize('main');

			// Write .git/info/exclude so IDE-internal files are invisible to git status
			await fileSystem.mkdir(`${PROJECT_ROOT}/.git/info`, { recursive: true });
			await fileSystem.writeFile(`${PROJECT_ROOT}/.git/info/exclude`, GIT_EXCLUDE_CONTENT);

			await gitService.setConfig('user.name', 'IDE User');
			await gitService.setConfig('user.email', 'user@example.com');

			// Stage all files individually instead of using stageAll() which
			// relies on statusMatrix. Before the first commit, statusMatrix
			// may throw NotFoundError because HEAD cannot resolve.
			const allFiles = await listAllProjectFiles(fileSystem, PROJECT_ROOT);
			await gitService.stage(allFiles);

			await gitService.commit('Initial commit', {
				author: { name: 'IDE User', email: 'user@example.com' },
			});
		});

		this.broadcastGitStatusChanged();
	}

	// =========================================================================
	// Git — Status
	// =========================================================================

	/**
	 * Get the status of all changed files.
	 */
	async gitStatus(): Promise<GitStatusResponse> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();

			const isInitialized = await gitService.isInitialized();
			if (!isInitialized) {
				return { entries: [], initialized: false };
			}

			const entries = await gitService.getStatus();
			return { entries, initialized: true };
		});
	}

	// =========================================================================
	// Git — Staging
	// =========================================================================

	/**
	 * Stage files for commit.
	 */
	async gitStage(paths: string[]): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.stage(paths);
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Unstage files.
	 */
	async gitUnstage(paths: string[]): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.unstage(paths);
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Stage all changed files.
	 */
	async gitStageAll(): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.stageAll();
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Unstage all staged files.
	 */
	async gitUnstageAll(): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.unstageAll();
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Discard changes for a file.
	 */
	async gitDiscard(path: string): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.discardChanges(path);
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Discard all working directory changes.
	 */
	async gitDiscardAll(): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.discardAllChanges();
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	// =========================================================================
	// Git — Commits
	// =========================================================================

	/**
	 * Create a commit with the currently staged changes.
	 */
	async gitCommit(message: string, options?: { amend?: boolean }): Promise<GitCommitResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			const objectId = await gitService.commit(message, { amend: options?.amend });
			const gitStatus = await this.readStatusInline(gitService);
			return { objectId, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Get commit history.
	 */
	async gitLog(options?: { reference?: string; depth?: number }): Promise<GitCommitEntry[]> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			return gitService.log({ reference: options?.reference, depth: options?.depth });
		});
	}

	// =========================================================================
	// Git — Branches
	// =========================================================================

	/**
	 * List all branches.
	 */
	async gitBranches(): Promise<GitBranchesResponse> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			const branches = await gitService.listBranches();
			const current = await gitService.getCurrentBranch();
			return { branches, current };
		});
	}

	/**
	 * Create a new branch.
	 */
	async gitCreateBranch(name: string, checkout?: boolean): Promise<{ success: boolean }> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.createBranch(name, checkout ?? false);
			return { success: true };
		});
		if (checkout) {
			this.broadcastGitStatusChanged();
		}
		return result;
	}

	/**
	 * Delete a branch.
	 */
	async gitDeleteBranch(name: string): Promise<{ success: boolean }> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.deleteBranch(name);
			return { success: true };
		});
	}

	/**
	 * Rename a branch.
	 */
	async gitRenameBranch(oldName: string, newName: string): Promise<{ success: boolean }> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.renameBranch(oldName, newName);
			return { success: true };
		});
	}

	/**
	 * Checkout a branch or ref.
	 *
	 * Also triggers a full-reload broadcast so the editor refreshes file contents.
	 */
	async gitCheckout(reference: string): Promise<GitCheckoutResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.checkout(reference);
			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});

		// Trigger full reload so the editor refreshes file contents
		try {
			const projectId = this.ctx.id.toString();
			const coordinatorId = this.env.DO_PROJECT_COORDINATOR.idFromName(`project:${projectId}`);
			const coordinatorStub = this.env.DO_PROJECT_COORDINATOR.get(coordinatorId);
			await coordinatorStub.triggerUpdate({
				type: 'full-reload',
				path: '/',
				timestamp: Date.now(),
				isCSS: false,
			});
		} catch {
			// Non-fatal
		}

		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * Merge a branch into the current branch.
	 */
	async gitMerge(branch: string): Promise<GitMergeWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();
			const mergeResult = await gitService.merge(branch);
			const gitStatus = await this.readStatusInline(gitService);
			return { ...mergeResult, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	// =========================================================================
	// Git — Tags
	// =========================================================================

	/**
	 * List all tags.
	 */
	async gitTags(): Promise<string[]> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			return gitService.listTags();
		});
	}

	/**
	 * Create a lightweight tag.
	 */
	async gitCreateTag(name: string, reference?: string): Promise<{ success: boolean }> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.createTag(name, reference);
			return { success: true };
		});
	}

	/**
	 * Delete a tag.
	 */
	async gitDeleteTag(name: string): Promise<{ success: boolean }> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			await gitService.deleteTag(name);
			return { success: true };
		});
	}

	// =========================================================================
	// Git — Stash
	// =========================================================================

	/**
	 * Perform a stash operation.
	 */
	async gitStash(
		action: 'push' | 'pop' | 'apply' | 'drop' | 'clear',
		options?: { index?: number; message?: string },
	): Promise<GitMutationWithStatusResponse> {
		const result = await this.withGitMount(async () => {
			const gitService = this.createGitService();

			switch (action) {
				case 'push': {
					await gitService.stashPush(options?.message);
					break;
				}
				case 'pop': {
					await gitService.stashPop(options?.index);
					break;
				}
				case 'apply': {
					await gitService.stashApply(options?.index);
					break;
				}
				case 'drop': {
					await gitService.stashDrop(options?.index);
					break;
				}
				case 'clear': {
					await gitService.stashClear();
					break;
				}
			}

			const gitStatus = await this.readStatusInline(gitService);
			return { success: true, gitStatus };
		});
		this.broadcastGitStatusChanged();
		return result;
	}

	/**
	 * List stash entries.
	 */
	async gitStashList(): Promise<GitStashEntry[]> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			return gitService.stashList();
		});
	}

	// =========================================================================
	// Git — Diff
	// =========================================================================

	/**
	 * Get the diff for a single file.
	 */
	async gitDiff(path: string): Promise<GitFileDiff | undefined> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			return gitService.diffFile(path);
		});
	}

	/**
	 * Get the diff for a specific commit.
	 */
	async gitDiffCommit(objectId: string): Promise<GitFileDiff[]> {
		return this.withGitMount(async () => {
			const gitService = this.createGitService();
			return gitService.diffCommit(objectId);
		});
	}
}
