import { asBufferSource, deflate } from '@git/common/index';
import { objTypeCode, encodeObjHeader, concatChunks } from '@git/git/core/index';

import type { GitObjectType } from '@git/git/core/index';

/**
 * Builds a PACKv2 file from a list of thick objects (no deltas expected here).
 * Shared between upload-pack assembly and DO hydration segment builder.
 */
export async function buildPackV2(objs: { type: GitObjectType; payload: Uint8Array }[]): Promise<Uint8Array> {
	// Header: 'PACK' + version (2) + number of objects (big-endian)
	const hdr = new Uint8Array(12);
	hdr.set(new TextEncoder().encode('PACK'), 0);
	const dv = new DataView(hdr.buffer);
	dv.setUint32(4, 2); // version 2
	dv.setUint32(8, objs.length);

	const parts: Uint8Array[] = [hdr];
	for (const o of objs) {
		const typeCode = objTypeCode(o.type);
		const head = encodeObjHeader(typeCode, o.payload.byteLength);
		parts.push(head);
		const comp = await deflate(o.payload);
		parts.push(comp);
	}
	const body = concatChunks(parts);
	const sha = new Uint8Array(await crypto.subtle.digest('SHA-1', asBufferSource(body)));
	const out = new Uint8Array(body.length + 20);
	out.set(body, 0);
	out.set(sha, body.length);
	return out;
}
