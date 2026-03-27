/**
 * Git refs and HEAD management
 *
 * This module handles Git references (branches, tags) and HEAD state,
 * including resolution and updates with consistency guarantees.
 */

import { asTypedStorage } from './repo-state';

import type { RepoStateSchema, Head } from './repo-state';

/**
 * Retrieves all refs from storage
 * @param ctx - Durable Object state context
 * @returns Array of ref objects with name and oid, or empty array if none exist
 */
export async function getRefs(context: DurableObjectState): Promise<{ name: string; oid: string }[]> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	return (await store.get('refs')) ?? [];
}

/**
 * Updates refs in storage
 * @param ctx - Durable Object state context
 * @param refs - New refs array to store
 */
export async function setRefs(context: DurableObjectState, references: { name: string; oid: string }[]): Promise<void> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	await store.put('refs', references);
}

/**
 * Resolves the current HEAD state by looking up the target ref
 * @param ctx - Durable Object state context
 * @returns The resolved HEAD object with target and either oid or unborn flag
 */
export async function resolveHead(context: DurableObjectState): Promise<Head> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const [stored, references] = await Promise.all([store.get('head'), store.get('refs')]);
	const refs = references ?? [];

	// Determine target (default to main)
	const target = stored?.target || 'refs/heads/main';
	const match = refs.find((r) => r.name === target);
	return match ? ({ target, oid: match.oid } as Head) : ({ target, unborn: true } as Head);
}

/**
 * Sets HEAD to a new value
 * @param ctx - Durable Object state context
 * @param head - New HEAD value
 */
export async function setHead(context: DurableObjectState, head: Head): Promise<void> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	await store.put('head', head);
}

/**
 * Get HEAD and refs in a single operation
 * @param ctx - Durable Object state context
 * @returns Object containing HEAD and refs
 */
export async function getHeadAndRefs(context: DurableObjectState): Promise<{ head: Head; refs: { name: string; oid: string }[] }> {
	const store = asTypedStorage<RepoStateSchema>(context.storage);
	const [stored, references] = await Promise.all([store.get('head'), store.get('refs')]);
	const refs = references ?? [];

	const target = stored?.target || 'refs/heads/main';
	const match = refs.find((r) => r.name === target);
	const resolved = match ? ({ target, oid: match.oid } as Head) : ({ target, unborn: true } as Head);

	return { head: resolved, refs };
}
