// Centralized helpers for building repo IDs and R2/DO key paths
// Keep all key/prefix formats here to avoid divergence between tests and runtime.

// Build a repository ID from owner + repo. Tests and routing expect "owner/repo".
export function repoKey(owner: string, repo: string): string {
	return `${owner}/${repo}`;
}

// Compute the Durable Object R2 prefix for a given DO instance ID.
// DO-backed data in R2 is stored under: "do/<durable-object-id>/..."
export function doPrefix(doId: string): string {
	return `do/${doId}`;
}

// R2 key for a loose object under a given DO prefix
export function r2LooseKey(prefix: string, oid: string): string {
	return `${prefix}/objects/loose/${oid}`;
}

// R2 key for a pack file under a given DO prefix
export function r2PackKey(prefix: string, name: string): string {
	return `${prefix}/objects/pack/${name}`;
}

// Given a .pack key, return its matching .idx key
export function packIndexKey(packKey: string): string {
	return packKey.replace(/\.pack$/, '.idx');
}

// Directory prefix for pack objects under a given DO prefix
export function r2PackDirPrefix(prefix: string): string {
	return `${prefix}/objects/pack/`;
}

// Return true if the key ends with .pack
export function isPackKey(key: string): boolean {
	return key.endsWith('.pack');
}

// Extract the Durable Object ID from a path starting with "do/<id>/..."
// Returns null when the path does not include the expected prefix.
export function getDoIdFromPath(path: string): string | null {
	const m = /^do\/([^/]+)/.exec(path);
	return m ? m[1] : null;
}
