/**
 * Replicate adapter module.
 *
 * Exports the Replicate text-completion adapter and tool call parsing utilities.
 * The tool call parsing logic is Replicate-specific because Replicate exposes Claude
 * as a text-completion endpoint that requires parsing XML `<tool_use>` blocks from
 * the model's text output. Other adapters handle tool calls natively and do not need
 * this parsing.
 */

export { createAdapter } from './adapter';
export { getModelLimits } from '@shared/constants';
export { normalizeFunctionCallsFormat, parseToolCalls, repairToolCallJson } from './tool-call-parser';
export type { ParsedToolCall } from './tool-call-parser';
