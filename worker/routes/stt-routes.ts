/**
 * Speech-to-Text WebSocket route using the Workers AI binding.
 *
 * Uses `env.AI.run("@cf/deepgram/nova-3", inputs, { websocket: true })`
 * which returns a WebSocket response directly. The client connects,
 * streams linear16 PCM audio, and receives JSON transcript messages
 * with `interim_results` support.
 *
 * Based on: https://github.com/TimoWilhelm/cf-deepgram-flux-demo
 */

import { env } from 'cloudflare:workers';
import { Hono } from 'hono';

import { HttpErrorCode } from '@shared/http-errors';

import { trackSttEvent } from '../lib/analytics';
import { httpError } from '../lib/http-error';

import type { AppEnvironment } from '../types';

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

	const userId = c.get('userId');
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
	serverSocket.accept();

	// Relay: client → AI
	serverSocket.addEventListener('message', (event) => {
		try {
			aiSocket.send(event.data);
		} catch {
			// AI socket already closed
		}
	});

	// Relay: AI → client
	aiSocket.addEventListener('message', (event) => {
		try {
			serverSocket.send(event.data);
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

	serverSocket.addEventListener('close', () => {
		endSession();
		try {
			aiSocket.close();
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

	aiSocket.addEventListener('close', () => {
		endSession();
		try {
			serverSocket.close();
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

	return new Response(undefined, { status: 101, webSocket: clientSocket });
});
