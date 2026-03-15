/**
 * Project ID validation and pattern matching.
 *
 * Project IDs are short, URL-safe alphanumeric strings. The rest of
 * the codebase treats them as opaque identifiers. Conversion to/from
 * Durable Object IDs is handled in `worker/lib/project-id.ts`.
 */

/** Matches a valid project ID (lowercase alphanumeric, 1–50 chars). */
export const PROJECT_ID_PATTERN = /^[a-z\d]{1,50}$/;

/** Check whether a string is a valid project ID. */
export function isValidProjectId(value: string): boolean {
	if (!PROJECT_ID_PATTERN.test(value)) {
		return false;
	}
	try {
		const hex = toHex(value);
		return /^[a-f\d]{64}$/i.test(hex);
	} catch {
		return false;
	}
}

/**
 * Convert a project ID to its internal hex representation.
 * Exported for use by the worker-side DO bridge (`worker/lib/project-id.ts`).
 * Application code should NOT use this directly.
 * @internal
 */
export function toHex(projectId: string): string {
	let value = 0n;
	for (const char of projectId) {
		value = value * 36n + BigInt(Number.parseInt(char, 36));
	}
	return value.toString(16).padStart(64, '0');
}

/**
 * Convert an internal hex DO ID to a project ID.
 * Exported for use by the worker-side DO bridge (`worker/lib/project-id.ts`).
 * Application code should NOT use this directly.
 * @internal
 */
export function fromHex(hex: string): string {
	return BigInt(`0x${hex}`).toString(36);
}
