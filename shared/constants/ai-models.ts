/**
 * AI model configuration for the Worker IDE application.
 * Single source of truth for available models, types, and helper functions.
 */

/**
 * Configuration for an AI model.
 * This is the single source of truth for available models.
 * Both server-side validation and UI components use this configuration.
 *
 * To add a new model:
 * 1. Add a new entry to this array with id, label, and optional description
 * 2. That's it! The model will be available in the UI and validated on the server
 */
export interface AIModelConfig<TId extends string = string> {
	/** Unique identifier for the model (e.g., "anthropic/claude-4.5-haiku") */
	id: TId;
	/** Display label shown in the UI (e.g., "Haiku 4.5") */
	label: string;
	/** Optional description of the model's capabilities */
	description?: string;
	/** Maximum context window size in tokens */
	contextWindow: number;
	/** Maximum output tokens the model can generate per turn */
	maxOutput: number;
}

/**
 * Available AI models configuration.
 * Add new models here to make them available throughout the application.
 *
 * IMPORTANT: Model IDs must follow the format "provider/model-name" (e.g., "anthropic/claude-4.5-haiku")
 */
export const AI_MODELS = [
	{
		id: 'anthropic/claude-4.5-haiku',
		label: 'Claude Haiku 4.5',
		description: 'Fast and efficient for everyday tasks',
		contextWindow: 200_000,
		maxOutput: 8192,
	},
	// Add more models here as they become available:
	// {
	// 	id: 'anthropic/claude-4-sonnet',
	// 	label: 'Sonnet 4',
	// 	description: 'Balanced performance and capability',
	// 	contextWindow: 200_000,
	// 	maxOutput: 16_384,
	// },
] as const satisfies readonly AIModelConfig<`${string}/${string}`>[];

/**
 * Type for AI model IDs (Replicate format: "provider/model-name")
 */
export type AIModelId = (typeof AI_MODELS)[number]['id'];

/**
 * Array of model IDs for iteration
 */
export const AI_MODEL_IDS: readonly AIModelId[] = AI_MODELS.map((model) => model.id);

/**
 * Tuple of model IDs for Zod enum validation.
 * This is defined separately because z.enum() requires a tuple type [string, ...string[]].
 */
// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- Required for Zod enum tuple type
export const AI_MODEL_IDS_TUPLE = AI_MODEL_IDS as readonly [AIModelId, ...AIModelId[]];

/**
 * Default AI model ID
 */
export const DEFAULT_AI_MODEL: AIModelId = AI_MODELS[0].id;

/**
 * Model used for internal summarization tasks (e.g., web_fetch content summarization).
 */
export const SUMMARIZATION_AI_MODEL: AIModelId = 'anthropic/claude-4.5-haiku';

/**
 * Get the display label for a model ID.
 * Returns the ID itself if no matching model is found.
 */
export function getModelLabel(modelId: string): string {
	const model = AI_MODELS.find((m) => m.id === modelId);
	return model?.label ?? modelId;
}

/**
 * Get the full configuration for a model ID.
 * Returns undefined if no matching model is found.
 */
export function getModelConfig(modelId: string): AIModelConfig | undefined {
	return AI_MODELS.find((m) => m.id === modelId);
}

/**
 * Get context window limits for a model ID.
 * Returns the contextWindow and maxOutput from the model config,
 * or conservative defaults if the model is unknown.
 */
export function getModelLimits(modelId: string): { contextWindow: number; maxOutput: number } {
	const config = getModelConfig(modelId);
	if (config) {
		return { contextWindow: config.contextWindow, maxOutput: config.maxOutput };
	}
	return { contextWindow: 200_000, maxOutput: 8192 };
}
