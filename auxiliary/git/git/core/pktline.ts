// Minimal pkt-line encoder/decoder utilities for Git protocol v2
// See https://git-scm.com/docs/pack-protocol and protocol-v2 docs

const FLUSH = '0000'; // flush-pkt
const DELIM = '0001'; // delim-pkt
const RESPONSE_END = '0002'; // response-end-pkt

function toHex4(n: number): string {
	// 4 hex digits, lowercase
	return n.toString(16).padStart(4, '0');
}

// Parse a single pkt-line section and return lines plus the offset after the terminating flush (0000).
// If parsing fails, returns undefined.
/**
 * Parses a section of pkt-line data until a flush packet.
 * @param buf - Buffer containing pkt-line data
 * @returns Object with parsed lines and offset after the section, or undefined if invalid
 */
export function parsePktSection(buf: Uint8Array): { lines: string[]; offset: number } | undefined {
	const td = new TextDecoder();
	let off = 0;
	const lines: string[] = [];
	while (off + 4 <= buf.byteLength) {
		const hdr = td.decode(buf.subarray(off, off + 4));
		off += 4;
		if (hdr === FLUSH) {
			// finished section
			return { lines, offset: off };
		}
		if (hdr === DELIM || hdr === RESPONSE_END) {
			// For command sections in receive-pack we don't expect delim/response-end, treat as error
			return undefined;
		}
		const length_ = Number.parseInt(hdr, 16);
		if (!Number.isFinite(length_) || length_ < 4 || off + (length_ - 4) > buf.byteLength) {
			return undefined;
		}
		const payLength = length_ - 4;
		const payload = buf.subarray(off, off + payLength);
		off += payLength;
		lines.push(td.decode(payload).replace(/\r?\n$/, ''));
	}
	return undefined;
}

/**
 * Creates a pkt-line formatted packet from a string or byte array.
 * Prepends a 4-byte hex length prefix to the data.
 * @param s - Input string or byte array
 * @returns Pkt-line formatted byte array
 */
export function pktLine(s: string | Uint8Array): Uint8Array {
	const payload = typeof s === 'string' ? new TextEncoder().encode(s) : s;
	const length_ = payload.byteLength + 4; // length includes the 4-byte header
	const header = new TextEncoder().encode(toHex4(length_));
	const out = new Uint8Array(header.byteLength + payload.byteLength);
	out.set(header, 0);
	out.set(payload, header.byteLength);
	return out;
}

/**
 * Creates a flush packet (0000) to signal end of a pkt-line stream.
 * @returns Flush packet byte array
 */
export function flushPkt(): Uint8Array {
	return new TextEncoder().encode(FLUSH);
}

/**
 * Concatenates multiple byte arrays into a single array.
 * @param chunks - Array of byte arrays to concatenate
 * @returns Single concatenated byte array
 */
export function concatChunks(chunks: Uint8Array[]): Uint8Array {
	const total = chunks.reduce((accumulator, c) => accumulator + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

export type PktItem = { type: 'line'; text: string; raw: Uint8Array } | { type: 'flush' } | { type: 'delim' } | { type: 'response-end' };

// Decode a pkt-line framed buffer into items. Does not attempt to interpret lines.
/**
 * Decodes a buffer containing pkt-line formatted data.
 * Parses the stream into individual lines, flush, and delimiter packets.
 * @param buf - Buffer containing pkt-line data
 * @returns Array of decoded packets with type and content
 */
export function decodePktLines(buf: Uint8Array): PktItem[] {
	const td = new TextDecoder();
	let off = 0;
	const out: PktItem[] = [];
	while (off + 4 <= buf.byteLength) {
		const hdr = td.decode(buf.subarray(off, off + 4));
		off += 4;
		if (hdr === FLUSH) {
			out.push({ type: 'flush' });
			continue;
		}
		if (hdr === DELIM) {
			out.push({ type: 'delim' });
			continue;
		}
		if (hdr === RESPONSE_END) {
			out.push({ type: 'response-end' });
			continue;
		}
		const length_ = Number.parseInt(hdr, 16);
		if (!Number.isFinite(length_) || length_ < 4 || off + (length_ - 4) > buf.byteLength) {
			// Malformed; stop parsing to avoid infinite loop
			break;
		}
		const payLength = length_ - 4;
		const payload = buf.subarray(off, off + payLength);
		off += payLength;
		const text = td.decode(payload);
		out.push({ type: 'line', text, raw: payload });
	}
	return out;
}
