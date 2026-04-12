/**
 * Object Storage Binding
 *
 * A WorkerEntrypoint that provides project-scoped object storage (R2-backed)
 * to dynamically-loaded user workers. All keys are automatically prefixed
 * with `projects/{projectId}/` to enforce isolation between projects.
 *
 * Exposed as `env.STORAGE` in the user's worker code.
 *
 * The public API is a strict subset of R2Bucket so that code written in the
 * IDE preview works identically after deploying to a real R2 binding.
 * RpcTarget wrappers mirror R2Object / R2ObjectBody / R2Objects shapes for
 * safe cross-boundary serialisation.
 */

import { RpcTarget, WorkerEntrypoint, exports } from 'cloudflare:workers';

import { STORAGE_KEY_PREFIX } from '@shared/constants';

import type { ProjectMetadata } from '../durable/project-metadata';

// =============================================================================
// Constants
// =============================================================================

const MAX_KEY_LENGTH = 1024;

// =============================================================================
// Types
// =============================================================================

interface ObjectStorageProperties {
	projectId: string;
	/** Maximum bytes allowed for this project's storage. 0 = unlimited. */
	quotaBytes: number;
}

// =============================================================================
// RPC-safe wrappers (mirror R2Object / R2ObjectBody / R2Objects)
// =============================================================================

/**
 * RPC-safe wrapper that mirrors every property of R2Object.
 * The `key` is returned un-scoped (without the internal project prefix).
 */
class R2ObjectProxy extends RpcTarget {
	readonly key: string;
	readonly version: string;
	readonly size: number;
	readonly etag: string;
	readonly httpEtag: string;
	readonly checksums: R2Checksums;
	readonly uploaded: Date;
	readonly httpMetadata?: R2HTTPMetadata;
	readonly customMetadata?: Record<string, string>;
	readonly range?: R2Range;
	readonly storageClass: string;
	readonly ssecKeyMd5?: string;

	#r2Object: R2Object;

	constructor(r2Object: R2Object, unscopedKey: string) {
		super();
		this.#r2Object = r2Object;
		this.key = unscopedKey;
		this.version = r2Object.version;
		this.size = r2Object.size;
		this.etag = r2Object.etag;
		this.httpEtag = r2Object.httpEtag;
		this.checksums = r2Object.checksums;
		this.uploaded = r2Object.uploaded;
		this.httpMetadata = r2Object.httpMetadata;
		this.customMetadata = r2Object.customMetadata;
		this.range = r2Object.range;
		this.storageClass = r2Object.storageClass;
		this.ssecKeyMd5 = r2Object.ssecKeyMd5;
	}

	writeHttpMetadata(headers: Headers): void {
		this.#r2Object.writeHttpMetadata(headers);
	}
}

/**
 * RPC-safe wrapper that mirrors R2ObjectBody (extends R2ObjectProxy with body access).
 */
class R2ObjectBodyProxy extends R2ObjectProxy {
	readonly body: ReadableStream;
	readonly bodyUsed: boolean;

	#r2Body: R2ObjectBody;

	constructor(r2Body: R2ObjectBody, unscopedKey: string) {
		super(r2Body, unscopedKey);
		this.#r2Body = r2Body;
		this.body = r2Body.body;
		this.bodyUsed = r2Body.bodyUsed;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		return this.#r2Body.arrayBuffer();
	}

	async bytes(): Promise<Uint8Array> {
		return this.#r2Body.bytes();
	}

	async text(): Promise<string> {
		return this.#r2Body.text();
	}

	async json<T>(): Promise<T> {
		return this.#r2Body.json<T>();
	}

	async blob(): Promise<Blob> {
		return this.#r2Body.blob();
	}
}

/**
 * RPC-safe wrapper that mirrors R2Objects (the return type of R2Bucket.list).
 */
class R2ObjectsProxy extends RpcTarget {
	readonly objects: R2ObjectProxy[];
	readonly truncated: boolean;
	readonly cursor?: string;
	readonly delimitedPrefixes: string[];

	constructor(r2Objects: R2Objects, stripPrefix: (key: string) => string) {
		super();
		this.objects = r2Objects.objects.map((object) => new R2ObjectProxy(object, stripPrefix(object.key)));
		this.truncated = r2Objects.truncated;
		this.cursor = r2Objects.truncated ? r2Objects.cursor : undefined;
		this.delimitedPrefixes = r2Objects.delimitedPrefixes.map((prefix) => stripPrefix(prefix));
	}
}

// =============================================================================
// Key validation
// =============================================================================

function validateKey(key: string): void {
	if (key.length === 0) {
		throw new Error('Storage key cannot be empty');
	}
	if (key.length > MAX_KEY_LENGTH) {
		throw new Error(`Storage key exceeds maximum length of ${MAX_KEY_LENGTH} characters`);
	}
	if (key.startsWith('/')) {
		throw new Error('Storage key cannot start with /');
	}
	if (key.includes('..')) {
		throw new Error('Storage key cannot contain ".."');
	}
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Get the byte size of a value being written to storage.
 * ReadableStream values cannot be sized without consuming them,
 * so quota is only enforced for string and ArrayBuffer values.
 */
function getValueSize(value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob): number {
	if (typeof value === 'string') {
		return new TextEncoder().encode(value).byteLength;
	}
	if (value instanceof ArrayBuffer) {
		return value.byteLength;
	}
	if (ArrayBuffer.isView(value)) {
		return value.byteLength;
	}
	if (value instanceof Blob) {
		return value.size;
	}
	// ReadableStream or null: we can't know the size without consuming the stream.
	// Return 0 so the put() proceeds — the actual R2 object size will be
	// checked on the next quota-enforced operation.
	return 0;
}

/**
 * Format a byte count as a human-readable string (e.g. "12.3 MB").
 */
function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

// =============================================================================
// ObjectStorageBinding
// =============================================================================

/**
 * Project-scoped object storage binding backed by a shared R2 bucket.
 * All keys are automatically prefixed with `projects/{projectId}/`.
 *
 * Exposes a strict subset of the R2Bucket API (head, get, put, delete, list)
 * so user code is portable between the IDE preview and a real R2 binding.
 */
export class ObjectStorageBinding extends WorkerEntrypoint<Env, ObjectStorageProperties> {
	#scopedKey(key: string): string {
		validateKey(key);
		return `${STORAGE_KEY_PREFIX}${this.ctx.props.projectId}/${key}`;
	}

	#stripPrefix(scopedKey: string): string {
		const prefix = `${STORAGE_KEY_PREFIX}${this.ctx.props.projectId}/`;
		if (scopedKey.startsWith(prefix)) {
			return scopedKey.slice(prefix.length);
		}
		return scopedKey;
	}

	get #bucket(): R2Bucket {
		return this.env.STORAGE_BUCKET;
	}

	#getMetadataStub(): DurableObjectStub<ProjectMetadata> {
		const namespace = exports.ProjectMetadata;
		return namespace.getByName(`project:${this.ctx.props.projectId}`);
	}

	async #checkRateLimit(): Promise<void> {
		const { success } = await this.env.STORAGE_RATE_LIMITER.limit({ key: this.ctx.props.projectId });
		if (!success) {
			throw new Error('Storage rate limit exceeded. Please slow down and try again.');
		}
	}

	async #getUsageBytes(): Promise<number> {
		return this.#getMetadataStub().getStorageUsageBytes();
	}

	/**
	 * Retrieve object metadata without the body. Returns null if not found.
	 * Signature matches R2Bucket.head().
	 */
	async head(key: string): Promise<R2ObjectProxy | null> {
		await this.#checkRateLimit();
		const object = await this.#bucket.head(this.#scopedKey(key));
		if (!object) {
			return null; // eslint-disable-line unicorn/no-null
		}
		return new R2ObjectProxy(object, key);
	}

	/**
	 * Retrieve an object from storage. Returns null if not found.
	 * Signature matches R2Bucket.get().
	 */
	async get(key: string, options?: R2GetOptions): Promise<R2ObjectBodyProxy | R2ObjectProxy | null> {
		await this.#checkRateLimit();
		const result = await this.#bucket.get(this.#scopedKey(key), options);
		if (!result) {
			return null; // eslint-disable-line unicorn/no-null
		}
		// When onlyIf is used, result may be R2Object (no body) — mirror real R2 semantics.
		if (!('body' in result)) {
			return new R2ObjectProxy(result, key);
		}
		return new R2ObjectBodyProxy(result, key);
	}

	/**
	 * Store a value in object storage.
	 * Enforces the per-project storage quota before writing.
	 * Signature matches R2Bucket.put().
	 */
	async put(
		key: string,
		value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
		options?: R2PutOptions,
	): Promise<R2ObjectProxy | null> {
		await this.#checkRateLimit();
		const scopedKey = this.#scopedKey(key);
		const incomingSize = getValueSize(value);

		// Check quota before writing
		const quotaBytes = this.ctx.props.quotaBytes;
		if (quotaBytes > 0 && incomingSize > 0) {
			const currentUsage = await this.#getUsageBytes();
			if (currentUsage + incomingSize > quotaBytes) {
				throw new Error(
					`Storage quota exceeded. Usage: ${formatBytes(currentUsage)}, limit: ${formatBytes(quotaBytes)}. Free up space or upgrade your plan.`,
				);
			}
		}

		// Get old object size (if overwriting) to compute the delta
		const oldObject = await this.#bucket.head(scopedKey);
		const oldSize = oldObject?.size ?? 0;

		const r2Object = await this.#bucket.put(scopedKey, value, options);
		if (!r2Object) {
			return null; // eslint-disable-line unicorn/no-null
		}

		// Update usage counter: for streams we read the actual written size from R2
		let newSize = incomingSize;
		if (newSize === 0) {
			const written = await this.#bucket.head(scopedKey);
			newSize = written?.size ?? 0;
		}
		const delta = newSize - oldSize;
		if (delta !== 0) {
			await this.#getMetadataStub().adjustStorageUsageBytes(delta);
		}

		return new R2ObjectProxy(r2Object, key);
	}

	/**
	 * Delete one or more objects from storage.
	 * Signature matches R2Bucket.delete().
	 */
	async delete(keys: string | string[]): Promise<void> {
		await this.#checkRateLimit();
		const keyArray = Array.isArray(keys) ? keys : [keys];
		const scopedKeys = keyArray.map((k) => this.#scopedKey(k));

		// Sum the sizes of objects being deleted
		let totalDeletedBytes = 0;
		const headResults = await Promise.all(scopedKeys.map((k) => this.#bucket.head(k)));
		for (const result of headResults) {
			if (result) {
				totalDeletedBytes += result.size;
			}
		}

		await this.#bucket.delete(scopedKeys);

		// Decrement usage counter
		if (totalDeletedBytes > 0) {
			await this.#getMetadataStub().adjustStorageUsageBytes(-totalDeletedBytes);
		}
	}

	/**
	 * List objects in storage, optionally filtered by prefix.
	 * Signature matches R2Bucket.list().
	 */
	async list(options?: R2ListOptions): Promise<R2ObjectsProxy> {
		await this.#checkRateLimit();
		const scopedPrefix = `${STORAGE_KEY_PREFIX}${this.ctx.props.projectId}/`;
		const userPrefix = options?.prefix ?? '';
		if (userPrefix.includes('..')) {
			throw new Error('List prefix cannot contain ".."');
		}

		const result = await this.#bucket.list({
			...options,
			prefix: `${scopedPrefix}${userPrefix}`,
		});

		return new R2ObjectsProxy(result, (key) => this.#stripPrefix(key));
	}
}
