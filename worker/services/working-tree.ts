import { HIDDEN_ENTRIES } from '@shared/constants';

import type { TreeEntry, CommitFileEntry } from '@shared/git-types';
import type { GitStatusEntry } from '@shared/types';

/**
 * Compute the git blob OID for a file's content.
 * Git blobs are hashed as: SHA-1("blob <size>\0<content>")
 */
export async function computeBlobOid(content: Uint8Array): Promise<string> {
	const header = new TextEncoder().encode(`blob ${content.byteLength}\0`);
	const full = new Uint8Array(header.byteLength + content.byteLength);
	full.set(header, 0);
	full.set(content, header.byteLength);
	const hash = await crypto.subtle.digest('SHA-1', full);
	return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isDirectoryEntry(entry: unknown): entry is { name: string; isDirectory(): boolean } {
	return (
		entry !== null &&
		typeof entry === 'object' &&
		typeof Reflect.get(entry, 'name') === 'string' &&
		typeof Reflect.get(entry, 'isDirectory') === 'function'
	);
}

/**
 * Recursively list all files in the working tree.
 * Returns relative paths (e.g. "src/app.tsx").
 */
async function listWorkingTreeFiles(fileSystem: typeof import('node:fs/promises'), projectRoot: string, basePath = ''): Promise<string[]> {
	const files: string[] = [];
	const fullPath = basePath ? `${projectRoot}/${basePath}` : projectRoot;

	let entries: Array<{ name: string; isDirectory(): boolean }>;
	try {
		const rawEntries = await fileSystem.readdir(fullPath, { withFileTypes: true });
		entries = rawEntries.flatMap((entry) => (isDirectoryEntry(entry) ? [entry] : []));
	} catch {
		return files;
	}

	for (const entry of entries) {
		if (HIDDEN_ENTRIES.has(entry.name)) continue;
		if (entry.name.startsWith('.git')) continue;

		const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

		if (entry.isDirectory()) {
			const subFiles = await listWorkingTreeFiles(fileSystem, projectRoot, relativePath);
			files.push(...subFiles);
		} else {
			files.push(relativePath);
		}
	}

	return files;
}

/**
 * Compute git status by comparing working tree files against a committed tree.
 *
 * Note: This implementation treats all changes as unstaged (staged: false).
 * The staging area is managed separately in the ProjectDO's SQLite.
 */
export async function computeStatus(
	fileSystem: typeof import('node:fs/promises'),
	projectRoot: string,
	committedTree: TreeEntry[],
): Promise<GitStatusEntry[]> {
	const committed = new Map(committedTree.map((entry) => [entry.path, entry.oid]));
	const workingFiles = await listWorkingTreeFiles(fileSystem, projectRoot);
	const entries: GitStatusEntry[] = [];

	for (const filePath of workingFiles) {
		const fullPath = `${projectRoot}/${filePath}`;
		let content: Uint8Array;
		try {
			const buffer = await fileSystem.readFile(fullPath);
			content = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
		} catch {
			continue;
		}

		const workingOid = await computeBlobOid(content);
		const committedOid = committed.get(filePath);

		if (!committedOid) {
			entries.push({
				path: filePath,
				status: 'untracked',
				staged: false,
				headStatus: 0,
				workdirStatus: 2,
				stageStatus: 0,
			});
		} else if (committedOid !== workingOid) {
			entries.push({
				path: filePath,
				status: 'modified',
				staged: false,
				headStatus: 1,
				workdirStatus: 2,
				stageStatus: 0,
			});
		}
		committed.delete(filePath);
	}

	for (const [path] of committed) {
		entries.push({
			path,
			status: 'deleted',
			staged: false,
			headStatus: 1,
			workdirStatus: 0,
			stageStatus: 0,
		});
	}

	return entries.toSorted((a, b) => a.path.localeCompare(b.path));
}

/**
 * Collect changed files from the working tree for a commitTree() call.
 * Compares working tree against committed tree and returns new/modified file contents.
 *
 * @param stagedPaths - If provided, only include these paths. If empty/undefined, include all changes.
 */
export async function collectChanges(
	fileSystem: typeof import('node:fs/promises'),
	projectRoot: string,
	committedTree: TreeEntry[],
	stagedPaths?: string[],
): Promise<{ files: CommitFileEntry[]; deletedPaths: string[] }> {
	const committed = new Map(committedTree.map((entry) => [entry.path, entry.oid]));
	const workingFiles = await listWorkingTreeFiles(fileSystem, projectRoot);
	const stagedSet = stagedPaths ? new Set(stagedPaths) : undefined;

	const files: CommitFileEntry[] = [];
	const deletedPaths: string[] = [];

	for (const filePath of workingFiles) {
		if (stagedSet && !stagedSet.has(filePath)) continue;

		const fullPath = `${projectRoot}/${filePath}`;
		let content: Uint8Array;
		try {
			const buffer = await fileSystem.readFile(fullPath);
			content = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
		} catch {
			continue;
		}

		const workingOid = await computeBlobOid(content);
		const committedOid = committed.get(filePath);

		if (!committedOid || committedOid !== workingOid) {
			files.push({ path: filePath, content, mode: 0o10_0644 });
		}

		committed.delete(filePath);
	}

	for (const [path] of committed) {
		if (!stagedSet || stagedSet.has(path)) {
			deletedPaths.push(path);
		}
	}

	return { files, deletedPaths };
}

/**
 * Apply a git tree to the working tree (checkout operation).
 * Creates/updates/deletes files to match the target tree.
 *
 * @param blobFetcher - Function to fetch blob content by OID (from git worker)
 */
export async function applyTree(
	fileSystem: typeof import('node:fs/promises'),
	projectRoot: string,
	tree: TreeEntry[],
	blobFetcher: (oid: string) => Promise<Uint8Array | undefined>,
): Promise<void> {
	// Skip hidden entries so checkout and status operate on the same visible tree.
	const filteredTree = tree.filter((entry) => {
		const topLevel = entry.path.split('/')[0];
		return !HIDDEN_ENTRIES.has(topLevel) && !topLevel.startsWith('.git');
	});

	const currentFiles = new Set(await listWorkingTreeFiles(fileSystem, projectRoot));
	const targetPaths = new Set(filteredTree.map((entry) => entry.path));

	const deletedDirectories = new Set<string>();
	for (const filePath of currentFiles) {
		if (!targetPaths.has(filePath)) {
			try {
				await fileSystem.unlink(`${projectRoot}/${filePath}`);
				let remaining = filePath;
				let slashIndex = remaining.lastIndexOf('/');
				while (slashIndex > 0) {
					remaining = remaining.slice(0, slashIndex);
					deletedDirectories.add(remaining);
					slashIndex = remaining.lastIndexOf('/');
				}
			} catch {
				// Ignore races with concurrent file removal.
			}
		}
	}

	const sortedDirectories = [...deletedDirectories].toSorted((a, b) => b.length - a.length);
	for (const directory of sortedDirectories) {
		try {
			await fileSystem.rmdir(`${projectRoot}/${directory}`);
		} catch {
			// Ignore directories that still contain files.
		}
	}

	for (const entry of filteredTree) {
		const fullPath = `${projectRoot}/${entry.path}`;

		if (currentFiles.has(entry.path)) {
			try {
				const buffer = await fileSystem.readFile(fullPath);
				const content = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
				const currentOid = await computeBlobOid(content);
				if (currentOid === entry.oid) continue;
			} catch {
				// Fall through and rewrite the file.
			}
		}

		const content = await blobFetcher(entry.oid);
		if (!content) continue;

		const lastSlash = fullPath.lastIndexOf('/');
		if (lastSlash > 0) {
			const directory = fullPath.slice(0, lastSlash);
			await fileSystem.mkdir(directory, { recursive: true });
		}

		await fileSystem.writeFile(fullPath, content);

		if (entry.mode === 0o10_0755) {
			try {
				await fileSystem.chmod(fullPath, 0o755);
			} catch {
				// Some virtual filesystems do not support chmod.
			}
		}
	}
}
