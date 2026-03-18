import { createWorkersAiChat } from '@cloudflare/tanstack-ai';
import { env } from 'cloudflare:workers';

import type { AnyTextAdapter } from '@tanstack/ai/adapters';

export function createAdapter(modelId: string): AnyTextAdapter {
	return createWorkersAiChat(modelId, { binding: env.AI });
}
