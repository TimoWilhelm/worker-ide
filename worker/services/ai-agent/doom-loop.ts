import type { ModelMessage } from '@tanstack/ai';

const DOOM_LOOP_THRESHOLD = 3;
const MUTATION_FAILURE_ITERATION_THRESHOLD = 2;

/**
 * Machine-readable tag injected into corrective user messages by the agent loop
 * when mutation tools fail. The doom loop detector matches on this exact tag
 * instead of fragile natural-language string parsing.
 */
export const MUTATION_FAILURE_TAG = '[MUTATION_FAILURE]';

export interface DoomLoopResult {
	isDoomLoop: boolean;
	reason?: 'identical_calls' | 'mutation_failure_loop';
	toolName?: string;
	message?: string;
}

interface ToolCallRecord {
	name: string;
	arguments: string;
}

/**
 * Stateless doom loop detection for the AI agent.
 *
 * Detects when the agent is stuck in repetitive patterns by analyzing the message history:
 * 1. Identical consecutive tool calls (exact same name + arguments)
 * 2. Mutation failure loop (consecutive iterations where mutation tools fail)
 *
 * An "iteration" in the message history is a group of:
 *   assistant (with toolCalls) → tool result(s) → optional user corrective message
 *
 * NOTE: We intentionally do NOT detect "same tool, different arguments" as a loop.
 * Editing multiple different files in a row is legitimate work, not a doom loop.
 * Only truly identical calls (same tool + same arguments) indicate the model is stuck.
 *
 * Mutation failures are detected via the MUTATION_FAILURE_TAG that the agent loop
 * injects into corrective user messages, not by parsing natural-language content.
 */
export function detectDoomLoop(messages: ModelMessage[]): DoomLoopResult {
	const toolCalls: ToolCallRecord[] = [];

	// Extract all tool calls in order
	for (const message of messages) {
		if (message.role === 'assistant' && Array.isArray(message.toolCalls)) {
			for (const tc of message.toolCalls) {
				if (tc.type === 'function') {
					// Ensure string comparison for arguments
					const arguments_ = typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);

					toolCalls.push({
						name: tc.function.name,
						arguments: arguments_,
					});
				}
			}
		}
	}

	// 1. Check identical consecutive calls (same name AND same arguments)
	if (toolCalls.length >= DOOM_LOOP_THRESHOLD) {
		const recent = toolCalls.slice(-DOOM_LOOP_THRESHOLD);
		const first = recent[0];
		const allIdentical = recent.every((tc) => tc.name === first.name && tc.arguments === first.arguments);

		if (allIdentical) {
			return {
				isDoomLoop: true,
				reason: 'identical_calls',
				toolName: first.name,
				message: `Detected repeated identical calls to ${first.name}. The agent was stopped to prevent an infinite loop.`,
			};
		}
	}

	// 2. Check mutation failure loop
	// Parse the message history into iterations by scanning backwards.
	// Each iteration is bounded by an assistant message with toolCalls.
	// A mutation failure is signaled by a user message containing MUTATION_FAILURE_TAG,
	// which sits between the tool results and the next assistant message.
	let consecutiveMutationFailures = 0;
	let seenFailureThisIteration = false;

	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];

		if (message.role === 'user' && typeof message.content === 'string' && message.content.includes(MUTATION_FAILURE_TAG)) {
			seenFailureThisIteration = true;
		} else if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
			// Reached an iteration boundary (assistant message with tool calls)
			if (seenFailureThisIteration) {
				consecutiveMutationFailures++;
				if (consecutiveMutationFailures >= MUTATION_FAILURE_ITERATION_THRESHOLD) {
					return {
						isDoomLoop: true,
						reason: 'mutation_failure_loop',
						message:
							'Mutation tools (file_edit, file_write, etc.) have failed across multiple consecutive iterations. The agent was stopped to prevent wasting resources.',
					};
				}
				seenFailureThisIteration = false;
			} else {
				// This iteration had no mutation failure — streak is broken
				break;
			}
		}
		// Skip 'tool' messages — they sit between assistant and user messages
	}

	return { isDoomLoop: false };
}
