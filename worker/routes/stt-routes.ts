import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';

import { trackSttEvent } from '../lib/analytics';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

const STT_READY_DELAY_MS = 250;

/**
 * Call env.AI.run in WebSocket mode. The typed overload expects the audio
 * input shape, but WebSocket mode takes flat string params and returns a
 * Response (not the typed model output). We call the binding via its
 * generic `.run(model, inputs, options)` signature using an untyped
 * wrapper to avoid `as` type assertions.
 */
function runSttWebSocket(ai: Ai, parameters: Record<string, string>): Promise<Response> {
	// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- env.AI.run with { websocket: true } has a different contract than the typed overload
	return (ai as { run: (model: string, inputs: unknown, options: unknown) => Promise<Response> }).run('@cf/deepgram/nova-3', parameters, {
		websocket: true,
	});
}

export const sttRoutes = new Hono<AppEnvironment>().get('/stt/ws', async (c) => {
	if (c.req.header('Upgrade') !== 'websocket') {
		throw httpError(HttpErrorCode.VALIDATION_ERROR, 'Expected WebSocket upgrade', 426);
	}

	const { userId } = c.get('session');
	const projectId = c.get('projectId');
	const request = c.req.raw;
	const sessionStart = Date.now();

	trackSttEvent({
		userId,
		projectId,
		eventType: 'session_start',
		request,
	});

	const aiResponse = await runSttWebSocket(env.AI, {
		encoding: 'linear16',
		sample_rate: '16000',
		interim_results: 'true',
		punctuate: 'true',
		smart_format: 'true',
		// Enable endpoint detection — the model will send `speech_final: true`
		// when it detects the speaker has finished an utterance. The value is
		// the silence duration (ms) that triggers the endpoint.
		endpointing: '300',
		// Send an explicit UtteranceEnd message after this silence duration
		// following the last word, as a secondary signal.
		utterance_end_ms: '1000',
	});

	// The AI binding returns a 101 with a webSocket on the response.
	// Intercept with our own pair so we can detect close and track session_end.
	const aiSocket = aiResponse.webSocket;
	if (!aiSocket) {
		// Fallback: AI binding didn't return a WebSocket — return as-is
		return aiResponse;
	}
	aiSocket.accept();

	const pair = new WebSocketPair();
	const [clientSocket, serverSocket] = [pair[0], pair[1]];

	// Workers auto-reply to Close frames by default, so proxy sockets need
	// half-open mode to coordinate the client and upstream closes explicitly.
	// https://developers.cloudflare.com/workers/runtime-apis/websockets/#close-behavior
	serverSocket.accept({ allowHalfOpen: true });

	// Relay: client → AI
	// event.data may arrive as ArrayBuffer, string, or Blob depending on the
	// runtime. Workers WebSocket.send() only accepts string | ArrayBuffer |
	// ArrayBufferView — passing a Blob would coerce to "[object Blob]" text,
	// which the AI model can't parse (SchemaError). Convert Blobs to
	// ArrayBuffer before forwarding.
	serverSocket.addEventListener('message', (event) => {
		try {
			const { data } = event;
			if (data instanceof Blob) {
				void data.arrayBuffer().then((buffer) => {
					try {
						aiSocket.send(buffer);
					} catch {
						// AI socket already closed
					}
				});
			} else {
				aiSocket.send(data);
			}
		} catch {
			// AI socket already closed
		}
	});

	// Relay: AI → client (same Blob guard as above)
	aiSocket.addEventListener('message', (event) => {
		try {
			const { data } = event;
			if (data instanceof Blob) {
				void data.arrayBuffer().then((buffer) => {
					try {
						serverSocket.send(buffer);
					} catch {
						// Client socket already closed
					}
				});
			} else {
				serverSocket.send(data);
			}
		} catch {
			// Client socket already closed
		}
	});

	// Track session_end on close from either side
	let sessionEnded = false;
	const endSession = (error?: string) => {
		if (sessionEnded) return;
		sessionEnded = true;
		trackSttEvent({
			userId,
			projectId,
			eventType: 'session_end',
			durationMs: Date.now() - sessionStart,
			error,
			request,
		});
	};

	serverSocket.addEventListener('close', (event) => {
		endSession();
		try {
			aiSocket.close(event.code, event.reason);
		} catch {
			// Already closed
		}
	});
	serverSocket.addEventListener('error', () => {
		endSession('client_error');
		try {
			aiSocket.close();
		} catch {
			// Already closed
		}
	});

	aiSocket.addEventListener('close', (event) => {
		endSession();
		try {
			serverSocket.close(event.code, event.reason);
		} catch {
			// Already closed
		}
	});
	aiSocket.addEventListener('error', () => {
		endSession('ai_error');
		try {
			serverSocket.close();
		} catch {
			// Already closed
		}
	});

	setTimeout(() => {
		try {
			serverSocket.send(JSON.stringify({ type: 'stt:ready' }));
		} catch {
			// Client socket already closed
		}
	}, STT_READY_DELAY_MS);

	return new Response(undefined, { status: 101, webSocket: clientSocket });
});
