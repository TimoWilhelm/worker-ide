/**
 * Object Storage Binding
 *
 * A WorkerEntrypoint that provides project-scoped object storage (R2-backed)
 * to dynamically-loaded user workers. All keys are automatically prefixed
 * with `projects/{projectId}/` to enforce isolation between projects.
 *
 * Exposed as `env.STORAGE` in the user's worker code.
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

interface PutOptions {
	contentType?: string;
}

interface ListOptions {
	prefix?: string;
	limit?: number;
	cursor?: string;
}

interface StorageHeadResult {
	readonly size: number;
	readonly contentType: string;
	readonly uploaded: string;
}

interface StorageListObject {
	readonly key: string;
	readonly size: number;
	readonly uploaded: string;
}

interface StorageListResult {
	readonly objects: StorageListObject[];
	readonly truncated: boolean;
	readonly cursor?: string;
}

// =============================================================================
// RPC-friendly StorageObject
// =============================================================================

/**
 * An RPC-compatible wrapper around an R2 object body.
 * Extends RpcTarget so methods can be called across the RPC boundary.
 */
class StorageObject extends RpcTarget {
	readonly size: number;
	readonly contentType: string;
	readonly uploaded: string;
	readonly body: ReadableStream;

	#arrayBufferPromise: Promise<ArrayBuffer> | undefined;
	#textPromise: Promise<string> | undefined;
	#r2Body: R2ObjectBody;

	constructor(r2Object: R2ObjectBody) {
		super();
		this.#r2Body = r2Object;
		this.size = r2Object.size;
		this.contentType = r2Object.httpMetadata?.contentType ?? 'application/octet-stream';
		this.uploaded = r2Object.uploaded.toISOString();
		this.body = r2Object.body;
	}

	async text(): Promise<string> {
		if (!this.#textPromise) {
			this.#textPromise = this.#r2Body.text();
		}
		return this.#textPromise;
	}

	async arrayBuffer(): Promise<ArrayBuffer> {
		// Cache the arrayBuffer so it can only be consumed once
		if (!this.#arrayBufferPromise) {
			this.#arrayBufferPromise = this.#r2Body.arrayBuffer();
		}
		return this.#arrayBufferPromise;
	}

	async json(): Promise<unknown> {
		const text = await this.text();
		return JSON.parse(text);
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
function getValueSize(value: string | ArrayBuffer | ReadableStream): number {
	if (typeof value === 'string') {
		return new TextEncoder().encode(value).byteLength;
	}
	if (value instanceof ArrayBuffer) {
		return value.byteLength;
	}
	// ReadableStream: we can't know the size without consuming the stream.
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

	/**
	 * Store a value in object storage.
	 * Enforces the per-project storage quota before writing.
	 */
	async put(key: string, value: string | ArrayBuffer | ReadableStream, options?: PutOptions): Promise<void> {
		await this.#checkRateLimit();
		const scopedKey = this.#scopedKey(key);
		const incomingSize = getValueSize(value);

		// Check quota before writing
		const quotaBytes = this.ctx.props.quotaBytes;
		if (quotaBytes > 0 && incomingSize > 0) {
			const currentUsage = await this.usage();
			if (currentUsage + incomingSize > quotaBytes) {
				throw new Error(
					`Storage quota exceeded. Usage: ${formatBytes(currentUsage)}, limit: ${formatBytes(quotaBytes)}. Free up space or upgrade your plan.`,
				);
			}
		}

		// Get old object size (if overwriting) to compute the delta
		const oldObject = await this.#bucket.head(scopedKey);
		const oldSize = oldObject?.size ?? 0;

		const httpMetadata: R2HTTPMetadata = {};
		if (options?.contentType) {
			httpMetadata.contentType = options.contentType;
		}
		await this.#bucket.put(scopedKey, value, { httpMetadata });

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
	}

	/**
	 * Get the total bytes used by this project's storage.
	 * Reads from the DO-tracked counter (O(1)) instead of listing R2.
	 */
	async usage(): Promise<number> {
		return this.#getMetadataStub().getStorageUsageBytes();
	}

	/**
	 * Retrieve an object from storage. Returns null if not found.
	 */
	async get(key: string): Promise<StorageObject | null> {
		await this.#checkRateLimit();
		const object = await this.#bucket.get(this.#scopedKey(key));
		if (!object) {
			return null; // eslint-disable-line unicorn/no-null
		}
		return new StorageObject(object);
	}

	/**
	 * Retrieve an object's text content. Returns null if not found.
	 */
	async getText(key: string): Promise<string | null> {
		await this.#checkRateLimit();
		const object = await this.#bucket.get(this.#scopedKey(key));
		if (!object) {
			return null; // eslint-disable-line unicorn/no-null
		}
		return object.text();
	}

	/**
	 * Retrieve object metadata without the body. Returns null if not found.
	 */
	async head(key: string): Promise<StorageHeadResult | null> {
		await this.#checkRateLimit();
		const object = await this.#bucket.head(this.#scopedKey(key));
		if (!object) {
			return null; // eslint-disable-line unicorn/no-null
		}
		return {
			size: object.size,
			contentType: object.httpMetadata?.contentType ?? 'application/octet-stream',
			uploaded: object.uploaded.toISOString(),
		};
	}

	/**
	 * List objects in storage, optionally filtered by prefix.
	 */
	async list(options?: ListOptions): Promise<StorageListResult> {
		await this.#checkRateLimit();
		const scopedPrefix = `${STORAGE_KEY_PREFIX}${this.ctx.props.projectId}/`;
		const userPrefix = options?.prefix ?? '';
		if (userPrefix.includes('..')) {
			throw new Error('List prefix cannot contain ".."');
		}

		const result = await this.#bucket.list({
			prefix: `${scopedPrefix}${userPrefix}`,
			limit: options?.limit,
			cursor: options?.cursor,
		});

		return {
			objects: result.objects.map((object) => ({
				key: this.#stripPrefix(object.key),
				size: object.size,
				uploaded: object.uploaded.toISOString(),
			})),
			truncated: result.truncated,
			cursor: result.truncated ? result.cursor : undefined,
		};
	}

	/**
	 * Delete one or more objects from storage.
	 */
	async delete(key: string | string[]): Promise<void> {
		await this.#checkRateLimit();
		const keys = Array.isArray(key) ? key : [key];
		const scopedKeys = keys.map((k) => this.#scopedKey(k));

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
}
