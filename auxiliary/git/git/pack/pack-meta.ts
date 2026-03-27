import { bytesToHex } from '@git/common/index';

export type IdxParsed = { oids: string[]; offsets: number[] };

// ---- Low-level helpers migrated from assembler.ts ----

/**
 * Parses a Git pack index v2/v3 file.
 * Extracts object IDs and their offsets within the pack file.
 * Handles both 32-bit and 64-bit offsets.
 * @param buf - Raw index file bytes
 * @returns Parsed index with OIDs and offsets, or undefined if invalid
 */
export function parseIdxV2(buf: Uint8Array): { oids: string[]; offsets: number[] } | undefined {
	if (buf.byteLength < 8) return undefined;
	if (!(buf[0] === 0xff && buf[1] === 0x74 && buf[2] === 0x4f && buf[3] === 0x63)) return undefined;
	const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
	const version = dv.getUint32(4, false);
	if (version !== 2 && version !== 3) return undefined;
	let pos = 8;
	const fanout: number[] = [];
	for (let index = 0; index < 256; index++) {
		fanout.push(dv.getUint32(pos, false));
		pos += 4;
	}
	const n = fanout[255] || 0;
	const namesStart = pos;
	const namesEnd = namesStart + n * 20;
	const oids: string[] = [];
	for (let index = 0; index < n; index++) {
		const off = namesStart + index * 20;
		const hex = bytesToHex(buf.subarray(off, off + 20));
		oids.push(hex);
	}
	const crcsStart = namesEnd;
	const crcsEnd = crcsStart + n * 4;
	const offsStart = crcsEnd;
	const offsEnd = offsStart + n * 4;
	const largeOffsStart = offsEnd;
	// First pass to count large offsets
	let largeCount = 0;
	for (let index = 0; index < n; index++) {
		const u32 = dv.getUint32(offsStart + index * 4, false);
		if (u32 & 0x80_00_00_00) largeCount++;
	}
	const largeTableStart = largeOffsStart;
	const offsets: number[] = [];
	for (let index = 0; index < n; index++) {
		const u32 = dv.getUint32(offsStart + index * 4, false);
		if (u32 & 0x80_00_00_00) {
			const li = u32 & 0x7f_ff_ff_ff;
			const off64 = readUint64BE(dv, largeTableStart + li * 8);
			offsets.push(Number(off64));
		} else {
			offsets.push(u32 >>> 0);
		}
	}
	return { oids, offsets };
}

function readUint64BE(dv: DataView, pos: number): bigint {
	const hi = dv.getUint32(pos, false);
	const lo = dv.getUint32(pos + 4, false);
	return (BigInt(hi) << 32n) | BigInt(lo);
}

/**
 * Read and parse a PACK entry header at a given offset.
 * Returns type, header length, size varint bytes, and delta metadata if applicable.
 *
 * @param env Worker environment
 * @param key R2 key of the `.pack`
 * @param offset Byte offset from start of pack where object begins
 */
export async function readPackHeaderEx(
	environment: GitWorkerEnvironment,
	key: string,
	offset: number,
	options?: {
		limiter?: { run<T>(label: string, function_: () => Promise<T>): Promise<T> };
		countSubrequest?: (n?: number) => void;
		signal?: AbortSignal;
	},
): Promise<
	| {
			type: number;
			sizeVarBytes: Uint8Array;
			headerLen: number;
			baseOid?: string;
			baseRel?: number;
	  }
	| undefined
> {
	if (options?.signal?.aborted) return undefined;
	const head = await readPackRange(environment, key, offset, 128, options);
	if (!head) return undefined;
	let p = 0;
	const start = p;
	let c = head[p++];
	const type = (c >> 4) & 0x07;
	// collect size varint bytes
	while (c & 0x80) {
		c = head[p++];
	}
	const sizeVariableBytes = head.subarray(start, p);
	if (type === 7) {
		// REF_DELTA
		const baseOid = bytesToHex(head.subarray(p, p + 20));
		const headerLength = sizeVariableBytes.length + 20;
		return { type, sizeVarBytes: sizeVariableBytes, headerLen: headerLength, baseOid };
	}
	if (type === 6) {
		// OFS_DELTA
		const ofsStart = p;
		let x = 0;
		let b = head[p++];
		x = b & 0x7f;
		while (b & 0x80) {
			b = head[p++];
			x = ((x + 1) << 7) | (b & 0x7f);
		}
		const headerLength = sizeVariableBytes.length + (p - ofsStart);
		return { type, sizeVarBytes: sizeVariableBytes, headerLen: headerLength, baseRel: x };
	}
	return { type, sizeVarBytes: sizeVariableBytes, headerLen: sizeVariableBytes.length };
}

/**
 * Read a byte range from an R2 `.pack` object.
 */
export async function readPackRange(
	environment: GitWorkerEnvironment,
	key: string,
	offset: number,
	length: number,
	options?: {
		limiter?: { run<T>(label: string, function_: () => Promise<T>): Promise<T> };
		countSubrequest?: (n?: number) => void;
		signal?: AbortSignal;
	},
): Promise<Uint8Array | undefined> {
	if (options?.signal?.aborted) return undefined;
	const run = async () => {
		const object = await environment.REPO_BUCKET.get(key, { range: { offset, length } });
		if (!object) return;
		const ab = await object.arrayBuffer();
		return new Uint8Array(ab);
	};
	if (options?.limiter) {
		options.countSubrequest?.();
		return await options.limiter.run('r2:get-range', run);
	}
	return await run();
}

/**
 * Parse a PACK entry header from an in-memory pack buffer at the given offset.
 * Mirrors the behavior of readPackHeaderEx but avoids R2 range reads.
 */
export function readPackHeaderExFromBuf(
	buf: Uint8Array,
	offset: number,
):
	| {
			type: number;
			sizeVarBytes: Uint8Array;
			headerLen: number;
			baseOid?: string;
			baseRel?: number;
	  }
	| undefined {
	let p = offset;
	if (p >= buf.length) return undefined;
	const start = p;
	let c = buf[p++];
	const type = (c >> 4) & 0x07;
	// collect size varint bytes
	while (c & 0x80) {
		if (p >= buf.length) return undefined;
		c = buf[p++];
	}
	const sizeVariableBytes = buf.subarray(start, p);
	if (type === 7) {
		// REF_DELTA
		if (p + 20 > buf.length) return undefined;
		const baseOid = bytesToHex(buf.subarray(p, p + 20));
		const headerLength = sizeVariableBytes.length + 20;
		return { type, sizeVarBytes: sizeVariableBytes, headerLen: headerLength, baseOid };
	}
	if (type === 6) {
		// OFS_DELTA
		const ofsStart = p;
		if (p >= buf.length) return undefined;
		let x = 0;
		let b = buf[p++];
		x = b & 0x7f;
		while (b & 0x80) {
			if (p >= buf.length) return undefined;
			b = buf[p++];
			x = ((x + 1) << 7) | (b & 0x7f);
		}
		const headerLength = sizeVariableBytes.length + (p - ofsStart);
		return { type, sizeVarBytes: sizeVariableBytes, headerLen: headerLength, baseRel: x };
	}
	return { type, sizeVarBytes: sizeVariableBytes, headerLen: sizeVariableBytes.length };
}

/**
 * Encodes OFS_DELTA distance using Git's varint-with-add-one scheme.
 * Inverse of the decoding implemented in this module.
 * @param rel - Distance from delta object to its base in bytes (newOffset - baseOffset)
 * @returns Varint bytes encoding the relative distance
 */
export function encodeOfsDeltaDistance(rel: number): Uint8Array {
	// Correct inverse of the decoder used above:
	// Given X, produce groups g_k..g_0 such that:
	//   X = (((g_0 + 1) << 7 | g_1) + 1 << 7 | g_2) ... | g_k
	// We compute g_k first by peeling off low 7 bits, then iterate
	// with: prev = ((cur - g) >> 7) - 1 until prev < 0, finally reverse.
	if (rel <= 0) return new Uint8Array([0]);
	let current = rel >>> 0;
	const groups: number[] = [];
	while (true) {
		const g = current & 0x7f;
		groups.push(g);
		current = ((current - g) >>> 7) - 1;
		if (current < 0) break;
	}
	// Now groups = [g_k, g_{k-1}, ..., g_0]; emit in order g_0..g_k,
	// setting MSB on all but the final (least-significant) group.
	groups.reverse();
	for (let index = 0; index < groups.length - 1; index++) groups[index] |= 0x80;
	return new Uint8Array(groups);
}

// Utility: simple concurrency-limited mapper
export async function mapWithConcurrency<T, R>(items: T[], limit: number, function_: (item: T, index: number) => Promise<R>): Promise<R[]> {
	const out: R[] = Array.from({ length: items.length }) as R[];
	let index = 0;
	const workers = Array.from({ length: Math.min(limit, items.length) })
		.fill(0)
		.map(async () => {
			while (true) {
				const index_ = index++;
				if (index_ >= items.length) break;
				out[index_] = await function_(items[index_], index_);
			}
		});
	await Promise.all(workers);
	return out;
}
