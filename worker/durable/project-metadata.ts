import { DurableObject } from 'cloudflare:workers';

const STORAGE_KEY = {
	STORAGE_USAGE_BYTES: 'storageUsageBytes',
} as const;

export class ProjectMetadata extends DurableObject {
	getStorageUsageBytes(): number {
		return this.ctx.storage.kv.get<number>(STORAGE_KEY.STORAGE_USAGE_BYTES) ?? 0;
	}

	/**
	 * Adjust the object storage usage counter by a delta (positive or negative).
	 * Returns the new total.
	 */
	adjustStorageUsageBytes(delta: number): number {
		const current = this.getStorageUsageBytes();
		const updated = Math.max(0, current + delta);
		this.ctx.storage.kv.put(STORAGE_KEY.STORAGE_USAGE_BYTES, updated);
		return updated;
	}
}
