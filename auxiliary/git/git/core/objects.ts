/**
 * Git object encoding/decoding utilities
 */

import { deflate } from '@git/common/compression';
import { bytesToHex } from '@git/common/hex';

/**
 * Git object types
 */
export type GitObjectType = 'blob' | 'tree' | 'commit' | 'tag';

/**
 * Map Git object type to pack type code
 */
export function objTypeCode(type: GitObjectType): number {
	switch (type) {
		case 'commit': {
			return 1;
		}
		case 'tree': {
			return 2;
		}
		case 'blob': {
			return 3;
		}
		case 'tag': {
			return 4;
		}
		default: {
			throw new Error(`Unknown object type: ${type}`);
		}
	}
}

/**
 * Encode Git pack object header
 * @param type - Object type code (1=commit, 2=tree, 3=blob, 4=tag)
 * @param size - Object size in bytes
 * @returns Encoded header bytes
 */
export function encodeObjHeader(type: number, size: number): Uint8Array {
	let first = (type << 4) | (size & 0x0f);
	size >>= 4;
	const bytes: number[] = [];
	if (size > 0) first |= 0x80;
	bytes.push(first);
	while (size > 0) {
		let b = size & 0x7f;
		size >>= 7;
		if (size > 0) b |= 0x80;
		bytes.push(b);
	}
	return new Uint8Array(bytes);
}

/**
 * Create a Git object with header and compute its OID
 * @param type - Git object type
 * @param payload - Object content
 * @returns Object ID and raw bytes
 */
async function createGitObject(type: GitObjectType, payload: Uint8Array): Promise<{ oid: string; raw: Uint8Array }> {
	const header = new TextEncoder().encode(`${type} ${payload.byteLength}\0`);
	const raw = new Uint8Array(header.byteLength + payload.byteLength);
	raw.set(header, 0);
	raw.set(payload, header.byteLength);
	const hash = await crypto.subtle.digest('SHA-1', raw);
	const oid = bytesToHex(new Uint8Array(hash));
	return { oid, raw };
}

/**
 * Create and compress a Git object
 * @param type - Git object type
 * @param payload - Object content
 * @returns Object ID, raw bytes, and compressed bytes
 */
export async function encodeGitObject(
	type: GitObjectType,
	payload: Uint8Array,
): Promise<{ oid: string; raw: Uint8Array; zdata: Uint8Array }> {
	const { oid, raw } = await createGitObject(type, payload);
	const zdata = await deflate(raw);
	return { oid, raw, zdata };
}

/**
 * Parse a Git object to extract type and payload
 * @param raw - Raw Git object bytes (with header)
 * @returns Object type (GitObjectType) and payload
 */
export function parseGitObject(raw: Uint8Array): { type: GitObjectType; payload: Uint8Array } {
	// Find the null byte that separates header from content
	let nullIndex = -1;
	for (const [index, element] of raw.entries()) {
		if (element === 0) {
			nullIndex = index;
			break;
		}
	}

	if (nullIndex === -1) {
		throw new Error('Invalid Git object: no null byte found');
	}

	const header = new TextDecoder().decode(raw.subarray(0, nullIndex));
	const [typeString] = header.split(' ');
	const payload = raw.subarray(nullIndex + 1);

	if (typeString !== 'commit' && typeString !== 'tree' && typeString !== 'blob' && typeString !== 'tag') {
		throw new Error(`Invalid Git object type: ${typeString}`);
	}
	const type = typeString as GitObjectType;

	return { type, payload };
}
