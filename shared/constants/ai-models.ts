/**
 * AI model configuration — single source of truth for available models.
 * To add a new model, add an entry to AI_MODELS below.
 */

export type AIModelProvider = 'workers-ai';

export interface AIModelConfig<TId extends string = string> {
	id: TId;
	label: string;
	description?: string;
	provider: AIModelProvider;
	contextWindow: number;
	maxOutput: number;
}
export const AI_MODELS = [
	{
		id: '@cf/moonshotai/kimi-k2.5',
		label: 'Kimi K2.5',
		description: 'Powerful reasoning model',
		provider: 'workers-ai',
		contextWindow: 256_000,
		maxOutput: 16_384,
	},
] as const satisfies readonly AIModelConfig[];

export type AIModelId = (typeof AI_MODELS)[number]['id'];

export const AI_MODEL_IDS: readonly AIModelId[] = AI_MODELS.map((model) => model.id);

// z.enum() requires a tuple type [string, ...string[]]
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Required for Zod enum tuple type
export const AI_MODEL_IDS_TUPLE = AI_MODEL_IDS as readonly [AIModelId, ...AIModelId[]];

export const DEFAULT_AI_MODEL: AIModelId = AI_MODELS[0].id;

/** Used for internal summarization (e.g., web_fetch), not user-selectable. */
export const SUMMARIZATION_AI_MODEL: AIModelId = '@cf/moonshotai/kimi-k2.5';

export function getModelLabel(modelId: string): string {
	const model = AI_MODELS.find((m) => m.id === modelId);
	return model?.label ?? modelId;
}

export function getModelConfig(modelId: string): AIModelConfig | undefined {
	return AI_MODELS.find((m) => m.id === modelId);
}

export function getModelLimits(modelId: string): { contextWindow: number; maxOutput: number } {
	const config = getModelConfig(modelId);
	if (config) {
		return { contextWindow: config.contextWindow, maxOutput: config.maxOutput };
	}
	return { contextWindow: 200_000, maxOutput: 8192 };
}
