/**
 * AI Model Configuration
 *
 * Re-exports the AI model configuration from shared constants.
 * This ensures frontend and backend use the same model definitions.
 *
 * To add a new model, update AI_MODELS in shared/constants.ts.
 */

export { AI_MODELS, DEFAULT_AI_MODEL, getModelLabel, getModelConfig, type AIModelConfig, type AIModelId } from '@shared/constants';
