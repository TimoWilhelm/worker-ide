/**
 * Workers AI adapter for the Vercel AI SDK v6.
 *
 * Uses the `workers-ai-provider` package which wraps the `env.AI` binding
 * directly — no REST API proxy needed. The provider handles streaming,
 * tool calling, and structured output protocols natively.
 */

import { env } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';

import type { LanguageModel } from 'ai';

/**
 * Create a Vercel AI SDK v6 language model for Workers AI.
 *
 * @param modelId - Workers AI model ID (e.g. '@cf/moonshotai/kimi-k2.5')
 */
export function createAdapter(modelId: string): LanguageModel {
	return createWorkersAI({ binding: env.AI })(modelId);
}
