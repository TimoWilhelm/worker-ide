/**
 * ZIP file creation utilities.
 */

const CRC32_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let index = 0; index < 256; index++) {
		let c = index;
		for (let index_ = 0; index_ < 8; index_++) c = c & 1 ? 0xed_b8_83_20 ^ (c >>> 1) : c >>> 1;
		table[index] = c;
	}
	return table;
})();

function crc32(data: Uint8Array): number {
	let crc = 0xff_ff_ff_ff;
	for (let index = 0; index < data.length; index++) crc = CRC32_TABLE[(crc ^ data[index]) & 0xff] ^ (crc >>> 8);
	return (crc ^ 0xff_ff_ff_ff) >>> 0;
}

/**
 * Create a ZIP file from a record of file paths to contents.
 */
export function createZip(files: Record<string, string | Uint8Array>): Uint8Array {
	const encoder = new TextEncoder();
	const entries: { name: Uint8Array; data: Uint8Array; crc: number; offset: number }[] = [];
	const parts: Uint8Array[] = [];
	let offset = 0;

	for (const [name, content] of Object.entries(files)) {
		const nameBytes = encoder.encode(name);
		const dataBytes = typeof content === 'string' ? encoder.encode(content) : content;
		const fileCrc = crc32(dataBytes);

		const header = new Uint8Array(30 + nameBytes.length);
		const hv = new DataView(header.buffer);
		hv.setUint32(0, 0x04_03_4b_50, true);
		hv.setUint16(4, 20, true);
		hv.setUint32(14, fileCrc, true);
		hv.setUint32(18, dataBytes.length, true);
		hv.setUint32(22, dataBytes.length, true);
		hv.setUint16(26, nameBytes.length, true);
		header.set(nameBytes, 30);

		entries.push({ name: nameBytes, data: dataBytes, crc: fileCrc, offset });
		parts.push(header, dataBytes);
		offset += header.length + dataBytes.length;
	}

	const cdStart = offset;
	for (const entry of entries) {
		const cd = new Uint8Array(46 + entry.name.length);
		const cv = new DataView(cd.buffer);
		cv.setUint32(0, 0x02_01_4b_50, true);
		cv.setUint16(4, 20, true);
		cv.setUint16(6, 20, true);
		cv.setUint32(16, entry.crc, true);
		cv.setUint32(20, entry.data.length, true);
		cv.setUint32(24, entry.data.length, true);
		cv.setUint16(28, entry.name.length, true);
		cv.setUint32(42, entry.offset, true);
		cd.set(entry.name, 46);
		parts.push(cd);
		offset += cd.length;
	}

	const eocd = new Uint8Array(22);
	const event_ = new DataView(eocd.buffer);
	event_.setUint32(0, 0x06_05_4b_50, true);
	event_.setUint16(8, entries.length, true);
	event_.setUint16(10, entries.length, true);
	event_.setUint32(12, offset - cdStart, true);
	event_.setUint32(16, cdStart, true);
	parts.push(eocd);

	const total = parts.reduce((s, p) => s + p.length, 0);
	const result = new Uint8Array(total);
	let pos = 0;
	for (const part of parts) {
		result.set(part, pos);
		pos += part.length;
	}
	return result;
}
