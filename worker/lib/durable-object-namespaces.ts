/**
 * Retry-wrapped Durable Object namespaces.
 *
 * All Durable Object access in the worker should go through these namespaces
 * instead of using `exports` directly. This ensures every RPC call automatically
 * retries on transient failures with exponential backoff and jitter.
 *
 * The namespaces are lazily initialized on first access to avoid module
 * initialization ordering issues — `cloudflare:workers` `exports` may not
 * have DO bindings populated when this module is first evaluated.
 *
 * @see https://developers.cloudflare.com/durable-objects/best-practices/error-handling/
 */

import { exports } from 'cloudflare:workers';

import { withRetry } from './do-retry-proxy';

/**
 * Creates a lazily-initialized, retry-wrapped namespace.
 *
 * The actual `withRetry(getNamespace())` call is deferred until the first
 * property access on the returned proxy. This avoids "Cannot create proxy
 * with a non-object as target" errors when `exports.SomeDO` is `undefined`
 * during early module evaluation.
 */
function lazyNamespace<T extends Rpc.DurableObjectBranded>(getNamespace: () => DurableObjectNamespace<T>): DurableObjectNamespace<T> {
	let cached: DurableObjectNamespace<T> | undefined;

	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Lazy proxy: the empty object is replaced by real namespace delegation on first access.
	return new Proxy({} as DurableObjectNamespace<T>, {
		get(_target, property, receiver) {
			cached ??= withRetry(getNamespace());
			return Reflect.get(cached, property, receiver);
		},
	});
}

/**
 * Filesystem Durable Object namespace with automatic retry.
 * Used for all file system and git operations.
 */
export const filesystemNamespace = lazyNamespace(() => exports.DurableObjectFilesystem);

/**
 * Project Coordinator Durable Object namespace with automatic retry.
 * Used for HMR broadcasts, WebSocket messages, and real-time collaboration.
 */
export const coordinatorNamespace = lazyNamespace(() => exports.ProjectCoordinator);
