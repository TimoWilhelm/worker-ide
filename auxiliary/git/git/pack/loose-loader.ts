/**
 * Factory functions for creating loose object loaders
 * Used with createMemPackFs to enable thin pack resolution
 */

import { objKey } from '@git/do/index';
import { r2LooseKey } from '@git/keys';

import type { RepoDurableObject, TypedStorage, RepoStateSchema } from '@git/do/index';

/**
 * Create a loose object loader that reads from DO storage and R2
 * Used in unpack operations and connectivity checks
 *
 * @param store - Durable Object storage
 * @param env - Worker environment with R2 bucket
 * @param prefix - DO prefix for R2 keys
 * @returns Loader function that returns compressed object bytes
 */
export function createLooseLoader(
	store: TypedStorage<RepoStateSchema>,
	environment: GitWorkerEnvironment,
	prefix: string,
): (oid: string) => Promise<Uint8Array | undefined> {
	return async (oid: string): Promise<Uint8Array | undefined> => {
		// First try DO storage
		const z = (await store.get(objKey(oid))) as Uint8Array | ArrayBuffer | undefined;
		if (z) return z instanceof Uint8Array ? z : new Uint8Array(z);

		// Then try R2
		try {
			const o = await environment.REPO_BUCKET.get(r2LooseKey(prefix, oid));
			if (o) return new Uint8Array(await o.arrayBuffer());
		} catch {}

		return undefined;
	};
}

/**
 * Create a loose object loader that reads via DO stub fetch
 * Used in gitRead.ts for reading objects from outside the DO
 *
 * @param stub - Durable Object stub
 * @returns Loader function that returns compressed object bytes
 */
export function createStubLooseLoader(stub: DurableObjectStub<RepoDurableObject>): (oid: string) => Promise<Uint8Array | undefined> {
	return async (oid: string): Promise<Uint8Array | undefined> => {
		try {
			const object = await stub.getObject(oid);
			if (object) return object instanceof Uint8Array ? object : new Uint8Array(object);
		} catch {}
		return undefined;
	};
}
