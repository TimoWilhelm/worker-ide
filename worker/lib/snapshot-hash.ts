/** Hash a project snapshot deterministically to key the build cache. */
export async function hashSnapshot(snapshot: Record<string, string>): Promise<string> {
	const serialized = Object.keys(snapshot)
		.toSorted()
		.map((path) => `${path}\u0000${snapshot[path]}`)
		.join('\u0001');
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
	return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
