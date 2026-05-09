import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createAudioStreamSender } from './audio-stream-sender';

function createPcmChunk(durationMs: number): ArrayBuffer {
	const sampleCount = Math.round((16_000 * durationMs) / 1000);
	return new ArrayBuffer(sampleCount * 2);
}

function createSender() {
	return createAudioStreamSender({ getNow: () => Date.now() });
}

describe('createAudioStreamSender', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-04-12T20:00:00Z'));
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('buffers chunks until the transport is open and ready', () => {
		const send = vi.fn();
		const sender = createSender();
		const socket = { readyState: 1, send };
		const firstChunk = createPcmChunk(100);
		const secondChunk = createPcmChunk(100);

		sender.enqueue(firstChunk);
		sender.enqueue(secondChunk);
		sender.attachWebSocket(socket);
		sender.markTransportOpen();

		expect(send).not.toHaveBeenCalled();
		expect(sender.getBufferedDurationMs()).toBe(200);

		sender.markReady();

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenNthCalledWith(1, firstChunk);
		expect(send).toHaveBeenNthCalledWith(2, secondChunk);
		expect(sender.getBufferedDurationMs()).toBe(0);
	});

	it('drains buffered chunks in order at an aggressive but capped rate once the connection is ready', () => {
		const send = vi.fn();
		const sender = createSender();
		const socket = { readyState: 1, send };
		const chunks = [createPcmChunk(100), createPcmChunk(100), createPcmChunk(100), createPcmChunk(100)];

		for (const chunk of chunks) {
			sender.enqueue(chunk);
		}

		sender.attachWebSocket(socket);
		sender.markTransportOpen();
		sender.markReady();

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenNthCalledWith(1, chunks[0]);
		expect(send).toHaveBeenNthCalledWith(2, chunks[1]);
		expect(sender.getBufferedDurationMs()).toBe(200);

		vi.advanceTimersByTime(24);
		expect(send).toHaveBeenCalledTimes(2);

		vi.advanceTimersByTime(1);
		expect(send).toHaveBeenCalledTimes(3);
		expect(send).toHaveBeenNthCalledWith(3, chunks[2]);
		expect(sender.getBufferedDurationMs()).toBe(100);

		vi.advanceTimersByTime(25);
		expect(send).toHaveBeenCalledTimes(4);
		expect(send).toHaveBeenNthCalledWith(4, chunks[3]);
		expect(sender.getBufferedDurationMs()).toBe(0);
	});

	it('sends live chunks immediately once the queue is caught up', () => {
		const send = vi.fn();
		const sender = createSender();
		const socket = { readyState: 1, send };
		const bufferedChunk = createPcmChunk(100);
		const liveChunk = createPcmChunk(100);

		sender.enqueue(bufferedChunk);
		sender.attachWebSocket(socket);
		sender.markTransportOpen();
		sender.markReady();

		sender.enqueue(liveChunk);

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenNthCalledWith(2, liveChunk);
	});

	it('waits for websocket bufferedAmount pressure to drop before sending more', () => {
		const send = vi.fn();
		const socket = {
			readyState: 1,
			bufferedAmount: 0,
			send,
		};
		const sender = createAudioStreamSender({
			getNow: () => Date.now(),
			maxBufferedAmountBytes: 5000,
			initialBurstMs: 200,
		});
		const firstChunk = createPcmChunk(100);
		const secondChunk = createPcmChunk(100);

		sender.enqueue(firstChunk);
		sender.enqueue(secondChunk);
		sender.attachWebSocket(socket);
		sender.markTransportOpen();
		socket.bufferedAmount = 1000;
		sender.markReady();

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenNthCalledWith(1, firstChunk);
		expect(sender.getBufferedDurationMs()).toBe(100);

		vi.advanceTimersByTime(10);
		expect(send).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(10);
		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenNthCalledWith(2, secondChunk);
		expect(sender.getBufferedDurationMs()).toBe(0);
	});

	it('reset clears pending buffered audio', () => {
		const send = vi.fn();
		const sender = createSender();
		const socket = { readyState: 1, send };
		const chunks = [createPcmChunk(100), createPcmChunk(100), createPcmChunk(100), createPcmChunk(100)];

		sender.enqueue(chunks[0]);
		sender.enqueue(chunks[1]);
		sender.reset();

		expect(sender.getBufferedDurationMs()).toBe(0);
		expect(send).not.toHaveBeenCalled();

		for (const chunk of chunks) {
			sender.enqueue(chunk);
		}

		sender.attachWebSocket(socket);
		sender.markTransportOpen();
		sender.markReady();
		sender.reset();
		vi.runAllTimers();

		expect(send).toHaveBeenCalledTimes(2);
		expect(sender.getBufferedDurationMs()).toBe(0);
	});
});
