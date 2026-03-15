/**
 * Worker-side project ID ↔ Durable Object ID bridge.
 *
 * These functions are the ONLY place where project IDs are converted
 * to/from Durable Object hex IDs. All other code treats project IDs
 * as opaque strings.
 */

import { fromHex, toHex } from '@shared/project-id';

/** Convert a Durable Object ID to a project ID. */
export function generateProjectId(durableObjectId: DurableObjectId): string {
	return fromHex(durableObjectId.toString());
}

/**
 * Resolve a project ID to a Durable Object ID within a namespace.
 * Throws if the project ID does not map to a valid DO ID.
 */
export function toDurableObjectId<T extends Rpc.DurableObjectBranded>(
	namespace: DurableObjectNamespace<T>,
	projectId: string,
): DurableObjectId {
	return namespace.idFromString(toHex(projectId));
}
