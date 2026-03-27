import { createLogger } from '@git/common/index';
import { pktLine, flushPkt } from '@git/git/core/index';

export class SidebandProgressMux {
	private progressMessages: string[] = [];
	private progressIdx = 0;
	private lastProgressTime = 0;
	private inProgress = false;
	private resolveFirstProgress?: () => void;
	private firstProgressPromise: Promise<void>;
	private readonly intervalMs: number;

	constructor(intervalMs = 100) {
		this.intervalMs = intervalMs;
		this.firstProgressPromise = new Promise<void>((resolve) => {
			this.resolveFirstProgress = resolve;
		});
	}

	push(message: string): void {
		this.progressMessages.push(message);
		if (this.resolveFirstProgress) {
			this.resolveFirstProgress();
			this.resolveFirstProgress = undefined;
		}
	}

	async waitForFirst(timeoutMs = 20): Promise<void> {
		await Promise.race([this.firstProgressPromise, new Promise((r) => setTimeout(r, timeoutMs))]);
	}

	shouldSendProgress(): boolean {
		const now = Date.now();
		return now - this.lastProgressTime >= this.intervalMs && !this.inProgress && this.progressIdx < this.progressMessages.length;
	}

	async sendPending(emitFunction: (message: string) => void): Promise<void> {
		if (this.shouldSendProgress()) {
			this.inProgress = true;
			while (this.progressIdx < this.progressMessages.length) {
				emitFunction(this.progressMessages[this.progressIdx++]);
			}
			this.lastProgressTime = Date.now();
			this.inProgress = false;
		}
	}

	sendRemaining(emitFunction: (message: string) => void): void {
		while (this.progressIdx < this.progressMessages.length) {
			emitFunction(this.progressMessages[this.progressIdx++]);
		}
	}
}

function createSidebandTransform(options?: {
	onProgress?: (message: string) => void;
	signal?: AbortSignal;
}): TransformStream<Uint8Array, Uint8Array> {
	const maxChunk = 65_515;

	return new TransformStream<Uint8Array, Uint8Array>({
		async transform(chunk, controller) {
			if (options?.signal?.aborted) {
				controller.terminate();
				return;
			}

			for (let off = 0; off < chunk.byteLength; off += maxChunk) {
				const slice = chunk.subarray(off, Math.min(off + maxChunk, chunk.byteLength));
				const banded = new Uint8Array(1 + slice.byteLength);
				banded[0] = 0x01;
				banded.set(slice, 1);
				controller.enqueue(pktLine(banded));
			}
		},

		flush(_controller) {},
	});
}

export function emitProgress(controller: ReadableStreamDefaultController<Uint8Array>, message: string) {
	const message_ = new TextEncoder().encode(message);
	const banded = new Uint8Array(1 + message_.byteLength);
	banded[0] = 0x02;
	banded.set(message_, 1);
	controller.enqueue(pktLine(banded));
}

export function emitFatal(controller: ReadableStreamDefaultController<Uint8Array>, message: string) {
	const message_ = new TextEncoder().encode(`fatal: ${message}\n`);
	const banded = new Uint8Array(1 + message_.byteLength);
	banded[0] = 0x03;
	banded.set(message_, 1);
	controller.enqueue(pktLine(banded));
}

export async function pipePackWithSideband(
	packStream: ReadableStream<Uint8Array>,
	controller: ReadableStreamDefaultController<Uint8Array>,
	options: {
		signal?: AbortSignal;
		progressMux: SidebandProgressMux;
		log: ReturnType<typeof createLogger>;
	},
): Promise<void> {
	const { signal, progressMux, log } = options;

	try {
		const sidebandTransform = createSidebandTransform({ signal });
		const reader = packStream.pipeThrough(sidebandTransform).getReader();

		await progressMux.waitForFirst();
		progressMux.sendRemaining((message) => emitProgress(controller, message));

		while (true) {
			if (signal?.aborted) {
				log.debug('pipe:aborted');
				reader.cancel();
				break;
			}

			const { done, value } = await reader.read();
			if (done) break;

			await progressMux.sendPending((message) => emitProgress(controller, message));
			controller.enqueue(value);
		}

		progressMux.sendRemaining((message) => emitProgress(controller, message));
		controller.enqueue(flushPkt());
	} catch (error) {
		log.error('pipe:error', { error: String(error) });
		try {
			emitFatal(controller, String(error));
		} catch {}
		throw error;
	}
}
