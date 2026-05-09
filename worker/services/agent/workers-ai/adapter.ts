import { env } from 'cloudflare:workers';
import { createWorkersAI } from 'workers-ai-provider';

import type { LanguageModel } from 'ai';

/**
 * Metadata context for AI Gateway tracking.
 */
export interface WorkersAiContext {
	/** The generation type label (e.g. 'agent', 'compaction', 'title', 'web_summarize'). */
	generationType: string;
	projectId?: string;
	userId?: string;
	organizationId?: string;
}

/**
 * Create a Vercel AI SDK v6 language model for Workers AI.
 *
 * @param modelId - Workers AI model ID (e.g. '@cf/moonshotai/kimi-k2.6')
 * @param context - Metadata context for AI Gateway tracking
 */
export function createAdapter(modelId: string, context: WorkersAiContext): LanguageModel {
	return createWorkersAI({
		binding: env.AI,
		gateway: {
			id: 'default',
			metadata: {
				app: 'worker-ide',
				type: context.generationType,
				project_id: context.projectId ?? '',
				org_id: context.organizationId ?? '',
				user_id: context.userId ?? '',
			},
		},
	})(modelId, {
		extraHeaders: {
			'cf-aig-collect-log-payload': 'false',
		},
	});
}
