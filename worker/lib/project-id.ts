import { fromHex, toHex } from '@shared/project-id';
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
