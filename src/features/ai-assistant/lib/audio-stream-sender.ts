interface AudioSocket {
	readyState: number;
	bufferedAmount?: number;
	send: (data: string | ArrayBuffer | ArrayBufferView) => void;
}

interface QueuedAudioChunk {
	audioBuffer: ArrayBuffer;
	durationMs: number;
}

interface CreateAudioStreamSenderOptions {
	getNow?: () => number;
	schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
	cancel?: (timer: ReturnType<typeof setTimeout>) => void;
	sampleRate?: number;
	bytesPerSample?: number;
	maxDrainRate?: number;
	initialBurstMs?: number;
	maxBudgetMs?: number;
	maxBufferedAmountBytes?: number;
}

export interface AudioStreamSender {
	attachWebSocket: (webSocket: AudioSocket) => void;
	markTransportOpen: () => void;
	markReady: () => void;
	enqueue: (audioBuffer: ArrayBuffer) => void;
	reset: () => void;
	getBufferedDurationMs: () => number;
}

const OPEN_WEB_SOCKET_STATE = 1;
const DEFAULT_SAMPLE_RATE = 16_000;
const DEFAULT_BYTES_PER_SAMPLE = 2;
const DEFAULT_MAX_DRAIN_RATE = 4;
const DEFAULT_INITIAL_BURST_MS = 200;
const DEFAULT_MAX_BUDGET_MS = 400;
const DEFAULT_MAX_BUFFERED_AMOUNT_BYTES = 131_072;
const MIN_PUMP_DELAY_MS = 10;

// Buffered and live audio both flow through one queue. We only start draining
// after the server confirms the upstream STT pipeline is ready.
export function createAudioStreamSender(options: CreateAudioStreamSenderOptions = {}): AudioStreamSender {
	const getNow = options.getNow ?? (() => performance.now());
	const schedule = options.schedule ?? ((callback: () => void, delayMs: number) => setTimeout(callback, delayMs));
	const cancel = options.cancel ?? ((timer: ReturnType<typeof setTimeout>) => clearTimeout(timer));
	const sampleRate = options.sampleRate ?? DEFAULT_SAMPLE_RATE;
	const bytesPerSample = options.bytesPerSample ?? DEFAULT_BYTES_PER_SAMPLE;
	const maxDrainRate = options.maxDrainRate ?? DEFAULT_MAX_DRAIN_RATE;
	const initialBurstMs = options.initialBurstMs ?? DEFAULT_INITIAL_BURST_MS;
	const maxBudgetMs = Math.max(initialBurstMs, options.maxBudgetMs ?? DEFAULT_MAX_BUDGET_MS);
	const maxBufferedAmountBytes = options.maxBufferedAmountBytes ?? DEFAULT_MAX_BUFFERED_AMOUNT_BYTES;

	let webSocket: AudioSocket | undefined;
	let isTransportOpen = false;
	let isReady = false;
	let queuedDurationMs = 0;
	let availableBudgetMs = 0;
	let lastBudgetUpdateAtMs: number | undefined;
	let estimatedBufferedAmountBytes = 0;
	let lastBufferedAmountUpdateAtMs: number | undefined;
	let scheduledPumpAtMs: number | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let queue: QueuedAudioChunk[] = [];

	const clearTimer = () => {
		if (timer === undefined) {
			return;
		}

		cancel(timer);
		timer = undefined;
		scheduledPumpAtMs = undefined;
	};

	const canSend = () => webSocket?.readyState === OPEN_WEB_SOCKET_STATE && isTransportOpen && isReady;

	const getChunkDurationMs = (audioBuffer: ArrayBuffer) => (audioBuffer.byteLength / bytesPerSample / sampleRate) * 1000;
	const bytesPerMillisecondAtMaxDrainRate = (sampleRate * bytesPerSample * maxDrainRate) / 1000;

	const updateBudget = () => {
		// Budget grows faster than real time so we can catch up aggressively, but it
		// is capped to avoid dumping an unlimited burst into the backend.
		if (!isReady) {
			return;
		}

		const now = getNow();
		if (lastBudgetUpdateAtMs === undefined) {
			lastBudgetUpdateAtMs = now;
			return;
		}

		const elapsedMs = Math.max(0, now - lastBudgetUpdateAtMs);
		lastBudgetUpdateAtMs = now;
		availableBudgetMs = Math.min(maxBudgetMs, availableBudgetMs + elapsedMs * maxDrainRate);
	};

	const updateEstimatedBufferedAmount = () => {
		// WebSocket.bufferedAmount can lag behind rapid sends, so keep a conservative
		// local estimate and never go below the browser-reported value.
		const now = getNow();
		const actualBufferedAmount = webSocket?.bufferedAmount ?? 0;
		if (lastBufferedAmountUpdateAtMs === undefined) {
			lastBufferedAmountUpdateAtMs = now;
			estimatedBufferedAmountBytes = actualBufferedAmount;
			return;
		}

		const elapsedMs = Math.max(0, now - lastBufferedAmountUpdateAtMs);
		lastBufferedAmountUpdateAtMs = now;
		const drainedBytes = elapsedMs * bytesPerMillisecondAtMaxDrainRate;
		estimatedBufferedAmountBytes = Math.max(actualBufferedAmount, estimatedBufferedAmountBytes - drainedBytes);
	};

	const schedulePump = (delayMs: number) => {
		if (!canSend() || queue.length === 0) {
			return;
		}

		const now = getNow();
		const normalizedDelayMs = Math.max(MIN_PUMP_DELAY_MS, Math.ceil(delayMs));
		const runAtMs = now + normalizedDelayMs;
		if (scheduledPumpAtMs !== undefined && scheduledPumpAtMs <= runAtMs) {
			return;
		}

		clearTimer();
		scheduledPumpAtMs = runAtMs;
		timer = schedule(() => {
			timer = undefined;
			scheduledPumpAtMs = undefined;
			pump();
		}, normalizedDelayMs);
	};

	const pump = () => {
		clearTimer();
		if (!canSend()) {
			return;
		}

		// Drain in order while both limits allow it: time budget for model pacing
		// and byte budget for socket/back-end backpressure.
		updateBudget();
		updateEstimatedBufferedAmount();

		while (queue.length > 0) {
			const nextChunk = queue[0];
			if (!nextChunk) {
				break;
			}

			if (estimatedBufferedAmountBytes + nextChunk.audioBuffer.byteLength > maxBufferedAmountBytes) {
				schedulePump(MIN_PUMP_DELAY_MS);
				return;
			}

			if (availableBudgetMs < nextChunk.durationMs) {
				const missingBudgetMs = nextChunk.durationMs - availableBudgetMs;
				schedulePump(missingBudgetMs / maxDrainRate);
				return;
			}

			try {
				webSocket?.send(nextChunk.audioBuffer);
			} catch {
				return;
			}

			queue.shift();
			queuedDurationMs -= nextChunk.durationMs;
			estimatedBufferedAmountBytes += nextChunk.audioBuffer.byteLength;
			availableBudgetMs = Math.max(0, availableBudgetMs - nextChunk.durationMs);
			updateBudget();
			updateEstimatedBufferedAmount();
		}
	};

	return {
		attachWebSocket(socket) {
			webSocket = socket;
			if (socket.readyState === OPEN_WEB_SOCKET_STATE) {
				isTransportOpen = true;
			}
			pump();
		},
		markTransportOpen() {
			isTransportOpen = true;
			pump();
		},
		markReady() {
			isReady = true;
			// Allow a small initial burst so the first buffered audio is delivered fast
			// without waiting for the first timer tick.
			availableBudgetMs = initialBurstMs;
			lastBudgetUpdateAtMs = getNow();
			lastBufferedAmountUpdateAtMs = getNow();
			estimatedBufferedAmountBytes = webSocket?.bufferedAmount ?? 0;
			pump();
		},
		enqueue(audioBuffer) {
			const durationMs = getChunkDurationMs(audioBuffer);
			queue.push({ audioBuffer, durationMs });
			queuedDurationMs += durationMs;
			pump();
		},
		reset() {
			clearTimer();
			webSocket = undefined;
			isTransportOpen = false;
			isReady = false;
			queuedDurationMs = 0;
			availableBudgetMs = 0;
			lastBudgetUpdateAtMs = undefined;
			estimatedBufferedAmountBytes = 0;
			lastBufferedAmountUpdateAtMs = undefined;
			queue = [];
		},
		getBufferedDurationMs() {
			return queuedDurationMs;
		},
	};
}
