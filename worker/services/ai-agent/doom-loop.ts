import type { ModelMessage } from 'ai';

const DOOM_LOOP_THRESHOLD = 3;
const MUTATION_FAILURE_ITERATION_THRESHOLD = 2;
const REPEATED_ERROR_THRESHOLD = 3;

/**
 * Machine-readable tag injected into corrective user messages by the agent loop
 * when mutation tools fail. The doom loop detector matches on this exact tag
 * instead of fragile natural-language string parsing.
 */
export const MUTATION_FAILURE_TAG = '[MUTATION_FAILURE]';

export interface DoomLoopResult {
	isDoomLoop: boolean;
	reason?: 'identical_calls' | 'mutation_failure_loop' | 'repeated_error_pattern';
	toolName?: string;
	message?: string;
}

interface ToolCallRecord {
	name: string;
	arguments: string;
}

/**
 * Extract tool calls from a ModelMessage.
 *
 * Vercel AI SDK uses content arrays with `type: 'tool-call'` parts
 * for assistant messages (instead of a separate `toolCalls` field).
 */
function extractToolCalls(message: ModelMessage): ToolCallRecord[] {
	if (message.role !== 'assistant') return [];

	const content = message.content;
	if (typeof content === 'string') return [];
	if (!Array.isArray(content)) return [];

	const calls: ToolCallRecord[] = [];
	for (const part of content) {
		if (part.type === 'tool-call') {
			const arguments_ = typeof part.input === 'string' ? part.input : JSON.stringify(part.input);
			calls.push({ name: part.toolName, arguments: arguments_ });
		}
	}
	return calls;
}

/**
 * Check if a ModelMessage is an assistant message with tool calls.
 */
function hasToolCalls(message: ModelMessage): boolean {
	return extractToolCalls(message).length > 0;
}

/**
 * Extract text content from a ModelMessage.
 */
function getTextContent(message: ModelMessage): string {
	if (typeof message.content === 'string') return message.content;
	if (!Array.isArray(message.content)) return '';

	return message.content
		.filter((part): part is { type: 'text'; text: string } => part.type === 'text')
		.map((part) => part.text)
		.join('');
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
 *
 * @param messages - The full working message history.
 * @param currentRunStartIndex - Index in `messages` where the current agent run begins.
 *   Only tool calls from this index onward are considered for the identical-calls check,
 *   preventing false positives when the same files are read across separate user turns
 *   in the same session. Defaults to 0 (scan all messages) for backwards compatibility.
 */
export function detectDoomLoop(messages: ModelMessage[], currentRunStartIndex = 0): DoomLoopResult {
	const toolCalls: ToolCallRecord[] = [];

	// Extract tool calls only from the current agent run (startIndex onward)
	// to avoid false positives from previous user turns reading the same files.
	const startIndex = Math.max(0, Math.min(currentRunStartIndex, messages.length));
	for (let index = startIndex; index < messages.length; index++) {
		const message = messages[index];
		toolCalls.push(...extractToolCalls(message));
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

		if (message.role === 'user') {
			const textContent = getTextContent(message);
			if (textContent.includes(MUTATION_FAILURE_TAG)) {
				seenFailureThisIteration = true;
			}
		} else if (message.role === 'assistant' && hasToolCalls(message)) {
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

	// 3. Check repeated error pattern — same tool producing the same error code
	// across consecutive calls, even with different arguments.
	const errorResult = detectRepeatedErrorPattern(messages, startIndex);
	if (errorResult.isDoomLoop) {
		return errorResult;
	}

	return { isDoomLoop: false };
}

/**
 * Known error code prefixes emitted by tool executors.
 * These are bracketed tags at the start of error messages, e.g. `[INVALID_PATH] ...`.
 */
const ERROR_CODE_PATTERN = /^\[([A-Z_]+)\]/;

/**
 * Extract a structured error code from a tool result string.
 * Returns the bracketed code (e.g. "INVALID_PATH") or undefined.
 */
function extractErrorCode(resultText: string): string | undefined {
	const match = ERROR_CODE_PATTERN.exec(resultText);
	return match ? match[1] : undefined;
}

interface ToolResultRecord {
	toolName: string;
	errorCode: string;
}

/**
 * Detect repeated error patterns: if the last N tool results for the same
 * tool name all have the same error code prefix, the agent is stuck trying
 * different arguments but hitting the same error class.
 */
function detectRepeatedErrorPattern(messages: ModelMessage[], currentRunStartIndex = 0): DoomLoopResult {
	// Collect recent tool results with error codes (scan backwards, only within current run)
	const recentErrors: ToolResultRecord[] = [];
	const scanStart = Math.max(0, Math.min(currentRunStartIndex, messages.length));

	for (let index = messages.length - 1; index >= scanStart && recentErrors.length < REPEATED_ERROR_THRESHOLD * 2; index--) {
		const message = messages[index];
		if (message.role !== 'tool') continue;
		if (!Array.isArray(message.content)) continue;

		for (const part of message.content) {
			if (part.type !== 'tool-result') continue;
			const rawOutput: unknown = part.output;
			const text =
				typeof rawOutput === 'string'
					? rawOutput
					: typeof rawOutput === 'object' && rawOutput !== undefined && rawOutput !== null && 'value' in rawOutput
						? String((rawOutput as Record<string, unknown>).value) // eslint-disable-line @typescript-eslint/consistent-type-assertions -- narrowed above
						: '';
			const errorCode = extractErrorCode(text);
			if (errorCode) {
				recentErrors.push({ toolName: part.toolName, errorCode });
			}
		}
	}

	if (recentErrors.length < REPEATED_ERROR_THRESHOLD) {
		return { isDoomLoop: false };
	}

	// Check if the most recent N errors are for the same tool + same error code
	const first = recentErrors[0];
	const consecutive = recentErrors.slice(0, REPEATED_ERROR_THRESHOLD);
	const allSame = consecutive.every((record) => record.toolName === first.toolName && record.errorCode === first.errorCode);

	if (allSame) {
		return {
			isDoomLoop: true,
			reason: 'repeated_error_pattern',
			toolName: first.toolName,
			message: `Tool ${first.toolName} has failed ${REPEATED_ERROR_THRESHOLD} consecutive times with error [${first.errorCode}]. The agent was stopped to prevent wasting resources.`,
		};
	}

	return { isDoomLoop: false };
}
