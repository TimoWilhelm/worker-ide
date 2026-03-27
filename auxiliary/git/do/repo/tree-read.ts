/**
 * Tree read operations for RepoDO.
 *
 * Provides:
 * - materializeTree() — flat file listing at a ref
 * - getBlobContent() / getBlobContentBatch() — decompressed file content
 * - getLog() — commit history
 * - diffTrees() — compare two trees
 */

import { bytesToHex } from '@git/common/hex';
import { parseCommitText } from '@git/git/core/commit-parse';
import { inflateAndParseHeader } from '@git/git/core/object-parse';

import { getRefs as getReferences, resolveHead } from './refs';
import { getObject, getObjectsBatch } from './storage';

import type { TreeEntry as SharedTreeEntry, CommitLogEntry, TreeDiffEntry } from '@shared/git-types';

// ---------------------------------------------------------------------------
// materializeTree — flat file listing at a ref
// ---------------------------------------------------------------------------

/**
 * Resolve a ref name to a commit OID.
 * Handles "HEAD" by resolving through the HEAD target.
 * If referenceName is already a 40-char hex OID, returns it directly.
 */
async function resolveReferenceToCommitOid(context: DurableObjectState, referenceName: string): Promise<string | undefined> {
	if (/^[0-9a-f]{40}$/i.test(referenceName)) return referenceName;

	const references = await getReferences(context);
	const head = await resolveHead(context);

	let targetReference = referenceName;
	if (targetReference === 'HEAD' && head.target) {
		targetReference = head.target;
	}

	const matching = references.find((reference) => reference.name === targetReference);
	if (matching) return matching.oid;

	// Only fall back to HEAD oid when the caller actually asked for HEAD
	if (referenceName === 'HEAD') return head.oid;

	return undefined;
}

/**
 * Read and parse a commit object, returning its tree OID and parent OIDs.
 */
async function readCommitObject(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	commitOid: string,
): Promise<{ treeOid: string; parentOids: string[]; message: string; authorLine: string } | undefined> {
	const compressed = await getObject(context, environment, prefix, commitOid);
	if (!compressed) return undefined;

	const parsed = await inflateAndParseHeader(compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed));
	if (!parsed || parsed.type !== 'commit') return undefined;

	const text = new TextDecoder().decode(parsed.payload);
	const commit = parseCommitText(text);

	const authorLine = text.match(/^author (.+)$/m)?.[1] ?? '';

	return {
		treeOid: commit.tree,
		parentOids: commit.parents,
		message: commit.message,
		authorLine,
	};
}

/**
 * Parse binary tree entries from a tree object payload.
 */
export function parseTreeEntries(payload: Uint8Array): Array<{ mode: string; name: string; oid: string }> {
	const textDecoder = new TextDecoder();
	const entries: Array<{ mode: string; name: string; oid: string }> = [];
	let index = 0;

	while (index < payload.length) {
		let spaceIndex = index;
		while (spaceIndex < payload.length && payload[spaceIndex] !== 0x20) spaceIndex++;
		if (spaceIndex >= payload.length) break;

		const mode = textDecoder.decode(payload.subarray(index, spaceIndex));

		let nullIndex = spaceIndex + 1;
		while (nullIndex < payload.length && payload[nullIndex] !== 0x00) nullIndex++;
		if (nullIndex + 20 > payload.length) break;

		const name = textDecoder.decode(payload.subarray(spaceIndex + 1, nullIndex));
		const oidBytes = payload.subarray(nullIndex + 1, nullIndex + 21);
		const oid = bytesToHex(oidBytes);

		entries.push({ mode, name, oid });
		index = nullIndex + 21;
	}

	return entries;
}

/**
 * Recursively walk a tree and collect all file entries as a flat list.
 */
async function walkTreeRecursive(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	treeOid: string,
	basePath: string,
): Promise<SharedTreeEntry[]> {
	const compressed = await getObject(context, environment, prefix, treeOid);
	if (!compressed) return [];

	const parsed = await inflateAndParseHeader(compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed));
	if (!parsed || parsed.type !== 'tree') return [];

	const entries = parseTreeEntries(parsed.payload);
	const results: SharedTreeEntry[] = [];

	for (const entry of entries) {
		const fullPath = basePath ? `${basePath}/${entry.name}` : entry.name;
		const modeNumber = Number.parseInt(entry.mode, 8);

		if (entry.mode === '40000') {
			const subtreeFiles = await walkTreeRecursive(context, environment, prefix, entry.oid, fullPath);
			results.push(...subtreeFiles);
		} else {
			// Size is omitted (0) to avoid fetching and decompressing every blob
			// during tree materialization. Callers that need blob content fetch it
			// separately via getBlobContent().
			results.push({ path: fullPath, oid: entry.oid, mode: modeNumber, size: 0 });
		}
	}

	return results;
}

/**
 * Materialize the full file tree at a given ref.
 * Returns a flat list of all files with their OIDs, modes, and sizes.
 */
export async function materializeTree(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	reference: string,
): Promise<SharedTreeEntry[]> {
	const commitOid = await resolveReferenceToCommitOid(context, reference);
	if (!commitOid) return [];

	const commit = await readCommitObject(context, environment, prefix, commitOid);
	if (!commit) return [];

	return walkTreeRecursive(context, environment, prefix, commit.treeOid, '');
}

// ---------------------------------------------------------------------------
// getBlobContent — decompressed file content
// ---------------------------------------------------------------------------

/**
 * Get the decompressed content of a blob object (no git header).
 */
export async function getBlobContent(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	oid: string,
): Promise<Uint8Array | undefined> {
	const compressed = await getObject(context, environment, prefix, oid);
	if (!compressed) return undefined;

	const parsed = await inflateAndParseHeader(compressed instanceof Uint8Array ? compressed : new Uint8Array(compressed));
	if (!parsed || parsed.type !== 'blob') return undefined;

	return parsed.payload;
}

/**
 * Batch get blob contents.
 */
export async function getBlobContentBatch(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	oids: string[],
): Promise<Map<string, Uint8Array>> {
	const results = new Map<string, Uint8Array>();

	// Process in parallel with a concurrency limit
	const batchSize = 10;
	for (let index = 0; index < oids.length; index += batchSize) {
		const batch = oids.slice(index, index + batchSize);
		const promises = batch.map(async (oid) => {
			const content = await getBlobContent(context, environment, prefix, oid);
			if (content) results.set(oid, content);
		});
		await Promise.all(promises);
	}

	return results;
}

// ---------------------------------------------------------------------------
// getLog — commit history
// ---------------------------------------------------------------------------

/**
 * Parse a git author/committer signature line.
 * Format: "Name <email> timestamp timezone"
 */
function parseAuthorLine(line: string): { name: string; email: string; timestamp: number } {
	const match = line.match(/^(.*) <([^>]+)>\s+(\d+)\s+[+-]\d{4}$/);
	if (!match) return { name: 'Unknown', email: '', timestamp: 0 };
	return {
		name: match[1],
		email: match[2],
		timestamp: Number.parseInt(match[3], 10),
	};
}

/**
 * Get commit log starting from a ref, walking first-parent history.
 */
export async function getLog(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	options: { ref: string; depth?: number },
): Promise<CommitLogEntry[]> {
	const maxDepth = options.depth ?? 50;
	const startOid = await resolveReferenceToCommitOid(context, options.ref);
	if (!startOid) return [];

	const entries: CommitLogEntry[] = [];
	let currentOid: string | undefined = startOid;

	while (currentOid && entries.length < maxDepth) {
		const commit = await readCommitObject(context, environment, prefix, currentOid);
		if (!commit) break;

		entries.push({
			oid: currentOid,
			message: commit.message,
			author: parseAuthorLine(commit.authorLine),
			parentOids: commit.parentOids,
			treeOid: commit.treeOid,
		});

		// Follow first parent
		currentOid = commit.parentOids[0];
	}

	return entries;
}

// ---------------------------------------------------------------------------
// isAncestor — BFS through all parents to check ancestry
// ---------------------------------------------------------------------------

/**
 * Check if `ancestorOid` is reachable from `descendantRef` by walking all parents (BFS).
 * Returns true if ancestorOid appears in the commit graph reachable from descendantRef.
 *
 * Uses batch DO storage reads to minimize subrequests (O(n/batchSize) instead of O(n)).
 */
export async function isAncestor(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	ancestorOid: string,
	descendantReference: string,
	maxDepth = 1000,
): Promise<boolean> {
	const startOid = await resolveReferenceToCommitOid(context, descendantReference);
	if (!startOid) return false;
	if (startOid === ancestorOid) return true;

	const visited = new Set<string>();
	let frontier: string[] = [startOid];

	while (frontier.length > 0 && visited.size < maxDepth) {
		// Deduplicate frontier against visited set
		const batch = frontier.filter((oid) => !visited.has(oid));
		if (batch.length === 0) break;
		for (const oid of batch) visited.add(oid);

		// Batch-read commit objects from DO storage (single storage.get call per batch)
		const objectMap = await getObjectsBatch(context, batch);
		const nextFrontier: string[] = [];

		for (const oid of batch) {
			const data = objectMap.get(oid);
			if (!data) {
				// Fallback to individual read (R2) for objects not in DO storage
				const commit = await readCommitObject(context, environment, prefix, oid);
				if (!commit) continue;
				for (const parentOid of commit.parentOids) {
					if (parentOid === ancestorOid) return true;
					if (!visited.has(parentOid)) nextFrontier.push(parentOid);
				}
				continue;
			}

			const parsed = await inflateAndParseHeader(data);
			if (!parsed || parsed.type !== 'commit') continue;

			const text = new TextDecoder().decode(parsed.payload);
			const commit = parseCommitText(text);

			for (const parentOid of commit.parents) {
				if (parentOid === ancestorOid) return true;
				if (!visited.has(parentOid)) nextFrontier.push(parentOid);
			}
		}

		frontier = nextFrontier;
	}

	return false;
}

// ---------------------------------------------------------------------------
// diffTrees — compare two trees
// ---------------------------------------------------------------------------

/**
 * Build a flat OID map from a materialized tree.
 */
function buildOidMap(entries: SharedTreeEntry[]): Map<string, string> {
	const map = new Map<string, string>();
	for (const entry of entries) {
		map.set(entry.path, entry.oid);
	}
	return map;
}

/**
 * Compare two trees and return a list of changed files.
 */
export async function diffTrees(
	context: DurableObjectState,
	environment: GitWorkerEnvironment,
	prefix: string,
	baseReference: string,
	headReference: string,
): Promise<TreeDiffEntry[]> {
	const [baseTree, headTree] = await Promise.all([
		materializeTree(context, environment, prefix, baseReference),
		materializeTree(context, environment, prefix, headReference),
	]);

	const baseMap = buildOidMap(baseTree);
	const headMap = buildOidMap(headTree);
	const allPaths = new Set([...baseMap.keys(), ...headMap.keys()]);
	const diffs: TreeDiffEntry[] = [];

	for (const path of allPaths) {
		const baseOid = baseMap.get(path);
		const headOid = headMap.get(path);

		if (!baseOid && headOid) {
			diffs.push({ path, status: 'added', headOid });
		} else if (baseOid && !headOid) {
			diffs.push({ path, status: 'deleted', baseOid });
		} else if (baseOid && headOid && baseOid !== headOid) {
			diffs.push({ path, status: 'modified', baseOid, headOid });
		}
	}

	return diffs.sort((a, b) => a.path.localeCompare(b.path));
}
