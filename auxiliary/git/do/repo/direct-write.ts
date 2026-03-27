/**
 * Direct-write commit implementation.
 *
 * Creates blob, tree, and commit objects server-side without a git client.
 * This is the primary commit path for IDE operations — the agent writes files
 * to the working tree, then the main worker calls commitTree() to persist them.
 */

import { parseCommitText } from '@git/git/core/commit-parse';
import { inflateAndParseHeader } from '@git/git/core/object-parse';
import { encodeGitObject } from '@git/git/core/objects';

import { getRefs as getReferences, setRefs as setReferences, resolveHead, setHead } from './refs';
import { getObject, storeObject } from './storage';
import { parseTreeEntries } from './tree-read';

import type { CommitTreeOptions, CommitTreeResult } from '@shared/git-types';

/**
 * Build a git tree entry (binary format):
 * "<mode> <name>\0<20-byte oid>"
 */
function buildTreeEntry(mode: string, name: string, oidHex: string): Uint8Array {
	const oidBytes = new Uint8Array(20);
	for (let index = 0; index < 20; index++) {
		oidBytes[index] = Number.parseInt(oidHex.slice(index * 2, index * 2 + 2), 16);
	}
	const prefix = new TextEncoder().encode(`${mode} ${name}\0`);
	const entry = new Uint8Array(prefix.byteLength + 20);
	entry.set(prefix, 0);
	entry.set(oidBytes, prefix.byteLength);
	return entry;
}

/**
 * Represents a directory node while building the tree hierarchy.
 */
interface TreeNode {
	children: Map<string, TreeNode>;
	blobs: Map<string, { oid: string; mode: number }>;
}

/**
 * Build a tree hierarchy from a flat list of file entries.
 */
function buildTreeHierarchy(files: Array<{ path: string; oid: string; mode: number }>): TreeNode {
	const root: TreeNode = { children: new Map(), blobs: new Map() };

	for (const file of files) {
		const parts = file.path.split('/');
		let current = root;

		for (let index = 0; index < parts.length - 1; index++) {
			const directoryName = parts[index];
			if (!current.children.has(directoryName)) {
				current.children.set(directoryName, { children: new Map(), blobs: new Map() });
			}
			current = current.children.get(directoryName)!;
		}

		const fileName = parts.at(-1)!;
		current.blobs.set(fileName, { oid: file.oid, mode: file.mode });
	}

	return root;
}

/**
 * Recursively encode a TreeNode into git tree objects (bottom-up),
 * storing each tree object and returning its OID.
 */
async function encodeTreeNode(
	node: TreeNode,
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
): Promise<string> {
	// First, recursively encode all child directories
	const subtreeOids = new Map<string, string>();
	for (const [name, child] of node.children) {
		const subtreeOid = await encodeTreeNode(child, context, environment, prefix);
		subtreeOids.set(name, subtreeOid);
	}

	// Build sorted tree entries (git requires sorted order)
	const entries: Array<{ name: string; mode: string; oid: string }> = [];

	for (const [name, subtreeOid] of subtreeOids) {
		entries.push({ name, mode: '40000', oid: subtreeOid });
	}

	for (const [name, { oid, mode }] of node.blobs) {
		entries.push({ name, mode: mode.toString(8), oid });
	}

	// Git sorts tree entries as if directories have a trailing '/'
	entries.sort((a, b) => {
		const aKey = a.mode === '40000' ? `${a.name}/` : a.name;
		const bKey = b.mode === '40000' ? `${b.name}/` : b.name;
		return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
	});

	// Concatenate entries into tree content
	const entryBuffers = entries.map((entry) => buildTreeEntry(entry.mode, entry.name, entry.oid));
	const totalLength = entryBuffers.reduce((sum, buffer) => sum + buffer.byteLength, 0);
	const treeContent = new Uint8Array(totalLength);
	let offset = 0;
	for (const buffer of entryBuffers) {
		treeContent.set(buffer, offset);
		offset += buffer.byteLength;
	}

	// Create the git tree object
	const { oid, zdata } = await encodeGitObject('tree', treeContent);
	await storeObject(context, environment, prefix, oid, zdata);

	return oid;
}

/**
 * Create a commit with the given files, without needing a git client.
 *
 * This is the primary write path for IDE commits. The main worker collects
 * changed files from the working tree and sends them here.
 */
export async function commitTree(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	options: CommitTreeOptions,
): Promise<CommitTreeResult> {
	const { files, deletedPaths = [], message, author } = options;

	// Read refs and HEAD once upfront to use a single consistent snapshot
	// for both parent resolution and the final ref update.
	const references = await getReferences(context);
	const head = await resolveHead(context);

	// Resolve parent commit and its tree (if not initial commit)
	let parentOid: string | undefined;
	let existingFiles: Array<{ path: string; oid: string; mode: number }> = [];
	let resolvedTargetReference: string | undefined;

	if (options.parentRef) {
		resolvedTargetReference = options.parentRef;

		// If parentRef is "HEAD", resolve via head
		if (resolvedTargetReference === 'HEAD' && head.target) {
			resolvedTargetReference = head.target;
		}

		const matchingReference = references.find((reference) => reference.name === resolvedTargetReference);
		if (matchingReference) {
			parentOid = matchingReference.oid;

			// Read the parent's tree to merge with new files
			// We need to get the existing tree entries to apply deletions and modifications
			existingFiles = await materializeTreeFromCommit(context, environment, prefix, parentOid);
		}
	}

	// Apply changes: start with existing files, override with new content, remove deleted
	const deletedSet = new Set(deletedPaths);
	const newFileMap = new Map(files.map((file) => [file.path, file]));

	// Merge: keep existing files that aren't deleted or overwritten
	const mergedFiles: Array<{ path: string; oid: string; mode: number }> = [];

	for (const existing of existingFiles) {
		if (deletedSet.has(existing.path)) continue;
		if (newFileMap.has(existing.path)) continue;
		mergedFiles.push(existing);
	}

	// Create blob objects for new/updated files
	for (const file of files) {
		const { oid, zdata } = await encodeGitObject('blob', file.content);
		await storeObject(context, environment, prefix, oid, zdata);
		mergedFiles.push({
			path: file.path,
			oid,
			mode: file.mode ?? 0o10_0644,
		});
	}

	// Build tree hierarchy and encode
	const treeHierarchy = buildTreeHierarchy(mergedFiles);
	const treeOid = await encodeTreeNode(treeHierarchy, context, environment, prefix);

	// Build commit object
	const timestamp = Math.floor(Date.now() / 1000);
	const authorLine = `${author.name} <${author.email}> ${timestamp} +0000`;
	const committerLine = authorLine;

	let commitContent = `tree ${treeOid}\n`;
	if (parentOid) {
		commitContent += `parent ${parentOid}\n`;
	}
	commitContent += `author ${authorLine}\n`;
	commitContent += `committer ${committerLine}\n`;
	commitContent += `\n${message}`;

	// Ensure message ends with newline
	if (!message.endsWith('\n')) {
		commitContent += '\n';
	}

	const { oid: commitOid, zdata: commitZdata } = await encodeGitObject('commit', new TextEncoder().encode(commitContent));
	await storeObject(context, environment, prefix, commitOid, commitZdata);

	// Update refs using the same snapshot read at the start of this function.
	// This avoids a TOCTOU race where a concurrent push could advance the ref
	// between the initial read (for parent resolution) and the update.
	if (resolvedTargetReference) {
		// Update the target ref
		const updatedReferences = references.map((reference) =>
			reference.name === resolvedTargetReference ? { ...reference, oid: commitOid } : reference,
		);

		// If ref didn't exist, add it
		if (!updatedReferences.some((reference) => reference.name === resolvedTargetReference)) {
			updatedReferences.push({ name: resolvedTargetReference, oid: commitOid });
		}

		await setReferences(context, updatedReferences);
	} else {
		// Initial commit — create refs/heads/main and set HEAD
		await setReferences(context, [{ name: 'refs/heads/main', oid: commitOid }]);
		await setHead(context, { target: 'refs/heads/main' });
	}

	return { commitOid, treeOid };
}

/**
 * Materialize the tree from a commit OID (internal helper for commitTree).
 * Returns a flat list of files with their OIDs and modes.
 */
async function materializeTreeFromCommit(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	commitOid: string,
): Promise<Array<{ path: string; oid: string; mode: number }>> {
	// Read the commit object
	const commitZdata = await getObject(context, environment, prefix, commitOid);
	if (!commitZdata) return [];

	const commitParsed = await inflateAndParseHeader(commitZdata instanceof Uint8Array ? commitZdata : new Uint8Array(commitZdata));
	if (!commitParsed || commitParsed.type !== 'commit') return [];

	const commitText = new TextDecoder().decode(commitParsed.payload);
	const commit = parseCommitText(commitText);
	if (!commit.tree) return [];

	// Recursively walk the tree
	return walkTree(context, environment, prefix, commit.tree, '');
}

/**
 * Recursively walk a git tree object and collect all file entries.
 */
async function walkTree(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	treeOid: string,
	basePath: string,
): Promise<Array<{ path: string; oid: string; mode: number }>> {
	const treeZdata = await getObject(context, environment, prefix, treeOid);
	if (!treeZdata) return [];

	const treeParsed = await inflateAndParseHeader(treeZdata instanceof Uint8Array ? treeZdata : new Uint8Array(treeZdata));
	if (!treeParsed || treeParsed.type !== 'tree') return [];

	// Parse tree entries
	const entries = parseTreeEntries(treeParsed.payload);
	const results: Array<{ path: string; oid: string; mode: number }> = [];

	for (const entry of entries) {
		const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
		const modeNumber = Number.parseInt(entry.mode, 8);

		if (entry.mode === '40000') {
			// Directory — recurse
			const subtreeFiles = await walkTree(context, environment, prefix, entry.oid, fullPath);
			results.push(...subtreeFiles);
		} else {
			results.push({ path: fullPath, oid: entry.oid, mode: modeNumber });
		}
	}

	return results;
}
