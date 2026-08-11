import git from 'isomorphic-git';

import { HIDDEN_ENTRIES } from '@shared/constants';

import { withSpan } from '../lib/tracing';
import { ensureArtifactsRepo, mintArtifactsToken } from '../services/artifacts-repo';

import type { WorkspaceFsAdapter } from '../lib/workspace-fs-adapter';
import type { GitStatusEntry, GitFileStatus, GitBranchInfo, GitCommitEntry, GitFileDiff, GitMergeResult } from '@shared/types';

const DEFAULT_BRANCH = 'main';

export interface GitAuthor {
	name: string;
	email: string;
}

export interface GitStatusResponse {
	entries: GitStatusEntry[];
	initialized: boolean;
}

type OnAuth = () => { username: string; password: string };

/** Top-level entries that are never tracked by git (editor/agent internals). */
function isIgnored(filepath: string): boolean {
	const top = filepath.split('/')[0];
	return HIDDEN_ENTRIES.has(top);
}

function decode(bytes: Uint8Array): string {
	return new TextDecoder().decode(bytes);
}

/**
 * Git operations for a single project, running inside the project Durable
 * Object directly against its durable `Workspace` (no in-memory scratch FS).
 *
 * The working tree and a real `.git` (objects, refs, index) both live in the
 * Workspace. Cloudflare Artifacts remains the remote ("origin") and source of
 * truth for history: ref-changing operations are pushed synchronously.
 */
export class GitService {
	private readonly fs: WorkspaceFsAdapter;
	private readonly environment: Env;
	private readonly projectId: string;
	private readonly gitDirectory: string;

	private remoteUrl?: string;
	private writeToken?: string;

	constructor(fs: WorkspaceFsAdapter, environment: Env, projectId: string) {
		this.fs = fs;
		this.environment = environment;
		this.projectId = projectId;
		this.gitDirectory = `/${projectId}`;
	}

	// =========================================================================
	// Remote (Artifacts) plumbing
	// =========================================================================
	private async getHttp(): Promise<typeof import('isomorphic-git/http/web').default> {
		const module_ = await import('isomorphic-git/http/web');
		return module_.default;
	}

	private async getRemote(): Promise<string> {
		if (!this.remoteUrl) {
			const repo = await ensureArtifactsRepo(this.environment, this.projectId);
			this.remoteUrl = repo.remote;
		}
		return this.remoteUrl;
	}

	private async writeAuth(): Promise<OnAuth> {
		if (!this.writeToken) {
			const { secret } = await mintArtifactsToken(this.environment, this.projectId, 'write', 300);
			this.writeToken = secret;
		}
		const password = this.writeToken;
		return () => ({ username: 'x', password });
	}

	private base() {
		return { fs: this.fs, dir: this.gitDirectory };
	}

	async isInitialized(): Promise<boolean> {
		try {
			await git.resolveRef({ ...this.base(), ref: 'HEAD', depth: 1 });
			return true;
		} catch {
			// HEAD may exist without commits; fall back to checking for the git dir.
			try {
				await this.fs.stat('/.git');
				return true;
			} catch {
				return false;
			}
		}
	}

	// =========================================================================
	// Working-tree enumeration (excludes git + editor internals)
	// =========================================================================
	private async listWorkingFiles(): Promise<string[]> {
		const result: string[] = [];
		const walk = async (relative: string): Promise<void> => {
			const full = relative ? `/${relative}` : '/';
			const entries = await this.fs.readdir(full, { withFileTypes: true });
			for (const entry of entries) {
				if (typeof entry === 'string') continue;
				const child = relative ? `${relative}/${entry.name}` : entry.name;
				if (isIgnored(child)) continue;
				if (entry.isDirectory()) {
					await walk(child);
				} else {
					result.push(child);
				}
			}
		};
		await walk('');
		return result;
	}

	// =========================================================================
	// Status
	// =========================================================================
	private mapStatus(head: number, workdir: number, stage: number): { status: GitFileStatus; staged: boolean } | undefined {
		if (head === 1 && workdir === 1 && stage === 1) return undefined; // unmodified
		if (head === 0) {
			if (stage === 0) return { status: 'untracked', staged: false };
			if (stage === 3) return { status: 'untracked-partially-staged', staged: true };
			return { status: 'untracked-staged', staged: true };
		}
		if (workdir === 0) {
			return stage === 0 ? { status: 'deleted-staged', staged: true } : { status: 'deleted', staged: false };
		}
		if (stage === 1) return { status: 'modified', staged: false };
		if (stage === 3) return { status: 'modified-partially-staged', staged: true };
		return { status: 'modified-staged', staged: true };
	}

	async status(): Promise<GitStatusResponse> {
		if (!(await this.isInitialized())) return { entries: [], initialized: false };

		const matrix = await git.statusMatrix({ ...this.base(), filter: (filepath) => !isIgnored(filepath) });
		const entries: GitStatusEntry[] = [];
		for (const [filepath, head, workdir, stage] of matrix) {
			const mapped = this.mapStatus(head, workdir, stage);
			if (!mapped) continue;
			entries.push({
				path: filepath,
				status: mapped.status,
				staged: mapped.staged,
				headStatus: head,
				workdirStatus: workdir,
				stageStatus: stage,
			});
		}
		entries.sort((a, b) => a.path.localeCompare(b.path));
		return { entries, initialized: true };
	}

	// =========================================================================
	// Staging
	// =========================================================================
	private async stagePath(filepath: string): Promise<void> {
		const exists = await this.fs
			.access(`/${filepath}`)
			.then(() => true)
			.catch(() => false);
		await (exists ? git.add({ ...this.base(), filepath }) : git.remove({ ...this.base(), filepath }));
	}

	async stage(paths: string[]): Promise<GitStatusResponse> {
		for (const filepath of paths) await this.stagePath(filepath);
		return this.status();
	}

	async unstage(paths: string[]): Promise<GitStatusResponse> {
		for (const filepath of paths) await git.resetIndex({ ...this.base(), filepath });
		return this.status();
	}

	async stageAll(): Promise<GitStatusResponse> {
		const { entries } = await this.status();
		for (const entry of entries) await this.stagePath(entry.path);
		return this.status();
	}

	async unstageAll(): Promise<GitStatusResponse> {
		const { entries } = await this.status();
		for (const entry of entries) {
			if (entry.staged) await git.resetIndex({ ...this.base(), filepath: entry.path });
		}
		return this.status();
	}

	// =========================================================================
	// Discard
	// =========================================================================
	async discard(filepath: string): Promise<GitStatusResponse> {
		const headOid = await git.resolveRef({ ...this.base(), ref: 'HEAD' }).catch(() => {});
		let tracked = false;
		if (headOid) {
			tracked = await git
				.readBlob({ ...this.base(), oid: headOid, filepath })
				.then(() => true)
				.catch(() => false);
		}
		if (tracked) {
			await git.checkout({ ...this.base(), ref: 'HEAD', filepaths: [filepath], force: true });
		} else {
			await this.fs.rm(`/${filepath}`, { force: true }).catch(() => {});
			await git.resetIndex({ ...this.base(), filepath }).catch(() => {});
		}
		return this.status();
	}

	async discardAll(): Promise<GitStatusResponse> {
		const { entries } = await this.status();
		// Delete untracked files (not present in HEAD) then reset tracked ones.
		for (const entry of entries) {
			if (entry.headStatus === 0) {
				await this.fs.rm(`/${entry.path}`, { force: true }).catch(() => {});
				await git.resetIndex({ ...this.base(), filepath: entry.path }).catch(() => {});
			}
		}
		await git.checkout({ ...this.base(), ref: 'HEAD', force: true }).catch(() => {});
		return this.status();
	}

	// =========================================================================
	// Commit
	// =========================================================================
	async commit(message: string, author: GitAuthor): Promise<{ objectId: string; gitStatus: GitStatusResponse }> {
		let status = await this.status();
		const hasStaged = status.entries.some((entry) => entry.staged);
		if (!hasStaged) {
			// Match legacy behaviour: with nothing explicitly staged, commit all changes.
			for (const entry of status.entries) await this.stagePath(entry.path);
			status = await this.status();
			if (status.entries.length === 0) throw new Error('Nothing to commit');
		}

		const oid = await git.commit({
			...this.base(),
			message,
			author: { name: author.name, email: author.email },
		});

		await this.pushCurrentBranch();
		return { objectId: oid, gitStatus: await this.status() };
	}

	// =========================================================================
	// Log
	// =========================================================================
	private async toCommitEntries(reference: string, depth: number): Promise<GitCommitEntry[]> {
		try {
			const commits = await git.log({ ...this.base(), ref: reference, depth });
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
		} catch {
			return [];
		}
	}

	async log(reference: string, depth: number): Promise<GitCommitEntry[]> {
		return this.toCommitEntries(reference, depth);
	}

	// =========================================================================
	// Branches
	// =========================================================================
	async branches(): Promise<{ branches: GitBranchInfo[]; current: string | undefined }> {
		if (!(await this.isInitialized())) return { branches: [], current: undefined };
		const [names, current] = await Promise.all([
			git.listBranches(this.base()),
			git.currentBranch({ ...this.base(), fullname: false }).catch(() => {}),
		]);
		const branches = names.map((name) => ({ name, isCurrent: name === current }));
		return { branches, current: current ?? undefined };
	}

	async createBranch(name: string, checkout: boolean): Promise<void> {
		const existing = await git.listBranches(this.base());
		if (existing.includes(name)) throw new Error(`Branch '${name}' already exists`);
		await git.branch({ ...this.base(), ref: name, checkout });
		await this.pushBranch(name);
	}

	async deleteBranch(name: string): Promise<void> {
		const current = await git.currentBranch({ ...this.base(), fullname: false }).catch(() => {});
		if (current === name) throw new Error('Cannot delete the current branch');
		const existing = await git.listBranches(this.base());
		if (!existing.includes(name)) throw new Error(`Branch '${name}' not found`);
		await git.deleteBranch({ ...this.base(), ref: name });
		await this.pushDelete(`refs/heads/${name}`);
	}

	async renameBranch(oldName: string, newName: string): Promise<void> {
		const existing = await git.listBranches(this.base());
		if (!existing.includes(oldName)) throw new Error(`Branch '${oldName}' not found`);
		if (existing.includes(newName)) throw new Error(`Branch '${newName}' already exists`);
		await git.renameBranch({ ...this.base(), oldref: oldName, ref: newName });
		await this.pushBranch(newName);
		await this.pushDelete(`refs/heads/${oldName}`);
	}

	async checkout(reference: string): Promise<GitStatusResponse> {
		const branches = await git.listBranches(this.base());
		if (!branches.includes(reference)) throw new Error(`Branch '${reference}' not found`);
		await git.checkout({ ...this.base(), ref: reference, force: true });
		return this.status();
	}

	// =========================================================================
	// Merge (fast-forward only, matching legacy behaviour)
	// =========================================================================
	async merge(branch: string): Promise<GitMergeResult & { gitStatus: GitStatusResponse }> {
		const current = await git.currentBranch({ ...this.base(), fullname: true }).catch(() => {});
		if (!current) throw new Error('HEAD is detached');
		const branches = await git.listBranches(this.base());
		if (!branches.includes(branch)) throw new Error(`Branch '${branch}' not found`);

		const currentOid = await git.resolveRef({ ...this.base(), ref: current });
		const mergeOid = await git.resolveRef({ ...this.base(), ref: branch });

		if (currentOid === mergeOid) {
			return { alreadyMerged: true, gitStatus: await this.status() };
		}

		const isFastForward = await git.isDescendent({ ...this.base(), oid: mergeOid, ancestor: currentOid, depth: -1 }).catch(() => false);
		if (!isFastForward) {
			throw new Error(`Cannot fast-forward: branches have diverged. Merge of '${branch}' requires a merge commit (not yet supported).`);
		}

		await git.writeRef({ ...this.base(), ref: current, value: mergeOid, force: true });
		await git.checkout({ ...this.base(), ref: current.replace('refs/heads/', ''), force: true });
		await this.pushCurrentBranch();

		return { objectId: mergeOid, fastForward: true, gitStatus: await this.status() };
	}

	// =========================================================================
	// Tags
	// =========================================================================
	async tags(): Promise<string[]> {
		if (!(await this.isInitialized())) return [];
		return git.listTags(this.base());
	}

	async createTag(name: string, reference?: string): Promise<void> {
		const existing = await git.listTags(this.base());
		if (existing.includes(name)) throw new Error(`Tag '${name}' already exists`);
		const reference_ = reference ?? 'HEAD';
		const oid = await git.resolveRef({ ...this.base(), ref: reference_ }).catch(() => {});
		if (!oid) throw new Error('Cannot resolve reference for tag');
		await git.tag({ ...this.base(), ref: name, object: oid });
		await this.pushRef(`refs/tags/${name}`);
	}

	async deleteTag(name: string): Promise<void> {
		const existing = await git.listTags(this.base());
		if (!existing.includes(name)) throw new Error(`Tag '${name}' not found`);
		await git.deleteTag({ ...this.base(), ref: name });
		await this.pushDelete(`refs/tags/${name}`);
	}

	// =========================================================================
	// Diff
	// =========================================================================
	private async blobAt(reference: string, filepath: string): Promise<string | undefined> {
		try {
			const oid = await git.resolveRef({ ...this.base(), ref: reference });
			const { blob } = await git.readBlob({ ...this.base(), oid, filepath });
			return decode(blob);
		} catch {
			return undefined;
		}
	}

	async diffWorkingFile(filepath: string): Promise<GitFileDiff> {
		const beforeContent = (await this.blobAt('HEAD', filepath)) ?? '';
		const committed = (await this.blobAt('HEAD', filepath)) !== undefined;

		let afterContent = '';
		let onDisk = false;
		try {
			const buffer = await this.fs.readFile(`/${filepath}`, 'utf8');
			afterContent = typeof buffer === 'string' ? buffer : decode(new Uint8Array(buffer));
			onDisk = true;
		} catch {
			// Deleted from working tree
		}

		const status: GitFileDiff['status'] = committed ? (onDisk ? 'modified' : 'deleted') : 'added';
		return { path: filepath, status, hunks: [], beforeContent, afterContent };
	}

	private async treeFiles(reference: string): Promise<Map<string, string>> {
		const oid = await git.resolveRef({ ...this.base(), ref: reference }).catch(() => reference);
		const result = new Map<string, string>();
		const walked = await git.walk({
			...this.base(),
			trees: [git.TREE({ ref: oid })],
			map: async (filepath, [entry]) => {
				if (filepath === '.' || !entry) return;
				if ((await entry.type()) !== 'blob') return;
				result.set(filepath, await entry.oid());
				return;
			},
		});
		void walked;
		return result;
	}

	async diffCommit(objectId: string): Promise<Array<{ path: string; status: 'added' | 'modified' | 'deleted' }>> {
		const log = await git.log({ ...this.base(), ref: objectId, depth: 2 });
		if (log.length === 0) throw new Error('Commit not found');
		const parentOid = log[0].commit.parent[0];

		const headFiles = await this.treeFiles(objectId);
		const baseFiles = parentOid ? await this.treeFiles(parentOid) : new Map<string, string>();

		const result: Array<{ path: string; status: 'added' | 'modified' | 'deleted' }> = [];
		for (const [path, oid] of headFiles) {
			const baseOid = baseFiles.get(path);
			if (!baseOid) result.push({ path, status: 'added' });
			else if (baseOid !== oid) result.push({ path, status: 'modified' });
		}
		for (const [path] of baseFiles) {
			if (!headFiles.has(path)) result.push({ path, status: 'deleted' });
		}
		return result;
	}

	async diffFileAtCommit(objectId: string, filepath: string): Promise<GitFileDiff> {
		const log = await git.log({ ...this.base(), ref: objectId, depth: 2 });
		if (log.length === 0) throw new Error('Commit not found');
		const parentOid = log[0].commit.parent[0];

		const afterContent = (await this.blobAt(objectId, filepath)) ?? '';
		const commitHas = (await this.blobAt(objectId, filepath)) !== undefined;
		const beforeContent = parentOid ? ((await this.blobAt(parentOid, filepath)) ?? '') : '';
		const parentHas = parentOid ? (await this.blobAt(parentOid, filepath)) !== undefined : false;

		let status: GitFileDiff['status'];
		if (commitHas) status = parentHas ? 'modified' : 'added';
		else status = 'deleted';

		return { path: filepath, status, hunks: [], beforeContent, afterContent };
	}

	// =========================================================================
	// Initialization (new / cloned projects) and remote sync
	// =========================================================================
	async initAndCommit(message: string, author: GitAuthor): Promise<void> {
		if (!(await this.isInitialized())) {
			await git.init({ ...this.base(), defaultBranch: DEFAULT_BRANCH });
		}
		const files = await this.listWorkingFiles();
		if (files.length === 0) return;
		for (const filepath of files) await git.add({ ...this.base(), filepath });
		await git.commit({ ...this.base(), message, author: { name: author.name, email: author.email } });

		// The local commit is authoritative for the project. Syncing to the
		// Artifacts remote is best-effort here: transient remote/network errors
		// must not fail project creation — the next commit reconciles the push.
		try {
			await this.ensureOrigin();
			await this.pushCurrentBranch();
		} catch (error) {
			console.error('initAndCommit: initial push to Artifacts failed (will reconcile on next commit):', error);
		}
	}

	private async ensureOrigin(): Promise<void> {
		const url = await this.getRemote();
		const remotes = await git.listRemotes(this.base()).catch(() => []);
		if (!remotes.some((remote) => remote.remote === 'origin')) {
			await git.addRemote({ ...this.base(), remote: 'origin', url });
		}
	}

	private async pushCurrentBranch(): Promise<void> {
		const current = await git.currentBranch({ ...this.base(), fullname: false }).catch(() => {});
		if (current) await this.pushBranch(current);
	}

	private async pushBranch(name: string): Promise<void> {
		await this.pushRef(`refs/heads/${name}`);
	}

	private async pushRef(reference: string): Promise<void> {
		const http = await this.getHttp();
		const url = await this.getRemote();
		const onAuth = await this.writeAuth();
		await withSpan('git.push', () => git.push({ ...this.base(), http, url, ref: reference, force: true, onAuth }), {
			'git.ref': reference,
		});
	}

	private async pushDelete(reference: string): Promise<void> {
		const http = await this.getHttp();
		const url = await this.getRemote();
		const onAuth = await this.writeAuth();
		await git.push({ ...this.base(), http, url, ref: reference, delete: true, onAuth }).catch(() => {});
	}
}
