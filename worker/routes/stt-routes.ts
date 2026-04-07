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

	return runSttWebSocket(env.AI, {
		encoding: 'linear16',
		sample_rate: '16000',
		interim_results: 'true',
		punctuate: 'true',
		smart_format: 'true',
	});
});
