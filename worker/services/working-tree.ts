/**
 * Working Tree Service — reconciliation between ProjectDO's working tree
 * and the git worker's committed tree.
 *
 * The working tree lives in the ProjectDO's SQLite database (via DurableObjectFilesystem).
 * The committed tree lives in the git worker's RepoDO + R2.
 * This service handles:
 *
 * - computeStatus(): diff working tree vs committed tree -> GitStatusEntry[]
 * - applyTree(): materialize a git tree into the working tree (checkout)
 * - collectChanges(): gather changed files from working tree for commitTree()
 * - computeBlobOid(): SHA-1 of "blob <size>\0<content>" for status comparison
 */

import type { TreeEntry, CommitFileEntry } from '@shared/git-types';
import type { GitStatusEntry } from '@shared/types';

/** Files to exclude from git status and commit operations. */
const HIDDEN_ENTRIES = new Set(['.initialized', '.project-meta.json', '.agent', '.git']);

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
		// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- worker-fs-mount Dirent type
		entries = rawEntries as Array<{ name: string; isDirectory(): boolean }>;
	} catch {
		return files;
	}

	for (const entry of entries) {
		// Skip hidden/internal entries
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
	// Build a map of committed files: path -> oid
	const committed = new Map(committedTree.map((entry) => [entry.path, entry.oid]));

	// Walk the working tree
	const workingFiles = await listWorkingTreeFiles(fileSystem, projectRoot);
	const entries: GitStatusEntry[] = [];

	for (const filePath of workingFiles) {
		const fullPath = `${projectRoot}/${filePath}`;
		let content: Uint8Array;
		try {
			const buffer = await fileSystem.readFile(fullPath);
			content = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
		} catch {
			continue; // File disappeared between listing and reading
		}

		const workingOid = await computeBlobOid(content);
		const committedOid = committed.get(filePath);

		if (!committedOid) {
			// File exists in working tree but not in committed tree -> added
			entries.push({
				path: filePath,
				status: 'untracked',
				staged: false,
				headStatus: 0,
				workdirStatus: 2,
				stageStatus: 0,
			});
		} else if (committedOid !== workingOid) {
			// File differs -> modified
			entries.push({
				path: filePath,
				status: 'modified',
				staged: false,
				headStatus: 1,
				workdirStatus: 2,
				stageStatus: 0,
			});
		}
		// If OIDs match, file is unmodified — don't include in status

		committed.delete(filePath);
	}

	// Remaining committed entries = deleted from working tree
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
		// If staging is active, only include staged files
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
			// New or modified file
			files.push({ path: filePath, content, mode: 0o10_0644 });
		}

		committed.delete(filePath);
	}

	// Remaining committed entries = deleted (if staged or no staging filter)
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
	// Filter out hidden entries from the target tree so we don't write files
	// that would be invisible to listWorkingTreeFiles (and thus to status checks).
	const filteredTree = tree.filter((entry) => {
		const topLevel = entry.path.split('/')[0];
		return !HIDDEN_ENTRIES.has(topLevel) && !topLevel.startsWith('.git');
	});

	// Get current working tree files
	const currentFiles = new Set(await listWorkingTreeFiles(fileSystem, projectRoot));
	const targetPaths = new Set(filteredTree.map((entry) => entry.path));

	// Delete files that don't exist in the target tree
	const deletedDirectories = new Set<string>();
	for (const filePath of currentFiles) {
		if (!targetPaths.has(filePath)) {
			try {
				await fileSystem.unlink(`${projectRoot}/${filePath}`);
				// Track all ancestor directories for cleanup
				let remaining = filePath;
				let slashIndex = remaining.lastIndexOf('/');
				while (slashIndex > 0) {
					remaining = remaining.slice(0, slashIndex);
					deletedDirectories.add(remaining);
					slashIndex = remaining.lastIndexOf('/');
				}
			} catch {
				// File may already be gone
			}
		}
	}

	// Clean up empty parent directories (deepest first)
	const sortedDirectories = [...deletedDirectories].toSorted((a, b) => b.length - a.length);
	for (const directory of sortedDirectories) {
		try {
			await fileSystem.rmdir(`${projectRoot}/${directory}`);
		} catch {
			// Directory not empty or already gone
		}
	}

	// Create/update files from the target tree
	for (const entry of filteredTree) {
		const fullPath = `${projectRoot}/${entry.path}`;

		// Check if file needs updating (compare OIDs if file exists)
		if (currentFiles.has(entry.path)) {
			try {
				const buffer = await fileSystem.readFile(fullPath);
				const content = typeof buffer === 'string' ? new TextEncoder().encode(buffer) : new Uint8Array(buffer);
				const currentOid = await computeBlobOid(content);
				if (currentOid === entry.oid) continue; // File unchanged
			} catch {
				// File doesn't exist or can't be read, proceed to write
			}
		}

		// Fetch blob content and write
		const content = await blobFetcher(entry.oid);
		if (!content) continue;

		// Ensure parent directory exists
		const lastSlash = fullPath.lastIndexOf('/');
		if (lastSlash > 0) {
			const directory = fullPath.slice(0, lastSlash);
			await fileSystem.mkdir(directory, { recursive: true });
		}

		await fileSystem.writeFile(fullPath, content);

		// Preserve executable bit from git mode (0o100755 -> 0o755, else 0o644)
		if (entry.mode === 0o10_0755) {
			try {
				await fileSystem.chmod(fullPath, 0o755);
			} catch {
				// chmod may not be supported on all virtual FS implementations
			}
		}
	}
}
