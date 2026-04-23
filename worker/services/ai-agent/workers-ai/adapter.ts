import { env } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';

import type { LanguageModel } from 'ai';

/**
 * Create a Vercel AI SDK v6 language model for Workers AI.
 *
 * @param modelId - Workers AI model ID (e.g. '@cf/moonshotai/kimi-k2.6')
 */
export function createAdapter(modelId: string): LanguageModel {
	return createWorkersAI({ binding: env.AI })(modelId);
}
