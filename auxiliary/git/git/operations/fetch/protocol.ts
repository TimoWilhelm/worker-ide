import { asBodyInit } from '@git/common/index';
import { pktLine, flushPkt, concatChunks } from '@git/git/core/index';

/**
 * Builds an ACK/NAK-only response when no packfile is needed.
 */
export function buildAckOnlyResponse(ackOids: string[]): Response {
	const chunks: Uint8Array[] = [pktLine('acknowledgments\n')];

	if (ackOids && ackOids.length > 0) {
		for (let index = 0; index < ackOids.length; index++) {
			const oid = ackOids[index];
			const suffix = index === ackOids.length - 1 ? 'ready' : 'common';
			chunks.push(pktLine(`ACK ${oid} ${suffix}\n`));
		}
	} else {
		chunks.push(pktLine('NAK\n'));
	}

	chunks.push(flushPkt());

	return new Response(asBodyInit(concatChunks(chunks)), {
		status: 200,
		headers: {
			'Content-Type': 'application/x-git-upload-pack-result',
			'Cache-Control': 'no-cache',
		},
	});
}
