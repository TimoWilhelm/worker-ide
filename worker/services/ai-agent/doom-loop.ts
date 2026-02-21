/**
 * Doom loop detection for the AI agent.
 *
 * Fully stateless — all detection is derived from append-only history arrays.
 * No mutable flags or streaks; every check scans the tail of the relevant history.
 *
 * Detects when the agent is stuck in repetitive patterns:
 * 1. Identical consecutive tool calls (exact same name + input)
 * 2. Same-tool repetition (same tool called N times, even with different inputs)
 * 3. Repeated failure detection (same tool fails N consecutive times in history)
 * 4. No-progress detection (N consecutive iterations with zero file changes)
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Number of consecutive identical tool calls required to trigger doom loop detection.
 */
const DOOM_LOOP_THRESHOLD = 3;

/**
 * Number of consecutive calls to the same tool (with different inputs) to trigger
 * same-tool repetition detection. Higher than DOOM_LOOP_THRESHOLD because
 * it's normal to call file_read a few times in a row with different paths.
 */
const SAME_TOOL_THRESHOLD = 5;

/**
 * Number of consecutive failures of the same tool required to trigger failure loop detection.
 */
const FAILURE_LOOP_THRESHOLD = 3;

/**
 * Number of consecutive iterations with zero file changes required to trigger no-progress detection.
 */
const NO_PROGRESS_THRESHOLD = 2;

/**
 * Number of consecutive iterations where a mutation tool failed to trigger
 * mutation-failure-loop detection. This catches the pattern where the LLM
 * keeps retrying a failing mutation (e.g. file_patch) across iterations,
 * even when interleaved with successful read-only calls that dilute the
 * unified history.
 */
const MUTATION_FAILURE_ITERATION_THRESHOLD = 2;

/**
 * Maximum history size — large enough for all detection windows.
 */
const MAX_HISTORY = Math.max(DOOM_LOOP_THRESHOLD, SAME_TOOL_THRESHOLD);

// =============================================================================
// Types
// =============================================================================

interface ToolCallRecord {
	name: string;
	inputJson: string;
	failed: boolean;
}

// =============================================================================
// Doom Loop Detector
// =============================================================================

/**
 * Tracks tool calls and detects doom loops.
 * All detection is derived purely from the history arrays — no mutable state.
 *
 * Usage:
 * 1. Call `record()` after each tool call completes (with failed flag).
 * 2. Call `recordIterationProgress()` at the end of each iteration.
 * 3. Call detection methods to check for loops.
 * 4. Call `reset()` to clear history (e.g., when starting a new request).
 */
export class DoomLoopDetector {
	private history: ToolCallRecord[] = [];
	private failureHistory: ToolCallRecord[] = [];
	private iterationProgressHistory: boolean[] = [];
	private iterationMutationFailureHistory: boolean[] = [];
	private totalToolCalls = 0;

	/**
	 * Record a completed tool call (success or failure).
	 * Retains enough history for all detection windows.
	 */
	record(toolName: string, input: unknown, failed = false): void {
		this.history.push({
			name: toolName,
			inputJson: JSON.stringify(input),
			failed,
		});
		if (this.history.length > MAX_HISTORY) {
			this.history.shift();
		}
		this.totalToolCalls++;
	}

	/**
	 * Record a tool call failure. Convenience wrapper around `record()`.
	 * Also appends to the dedicated failure history for failure-loop detection.
	 */
	recordFailure(toolName: string): void {
		this.record(toolName, {}, true);
		this.failureHistory.push({ name: toolName, inputJson: '{}', failed: true });
		if (this.failureHistory.length > FAILURE_LOOP_THRESHOLD) {
			this.failureHistory.shift();
		}
	}

	/**
	 * Record whether an iteration made file-change progress.
	 * Only the last NO_PROGRESS_THRESHOLD entries are retained.
	 */
	recordIterationProgress(hadFileChanges: boolean): void {
		this.iterationProgressHistory.push(hadFileChanges);
		if (this.iterationProgressHistory.length > NO_PROGRESS_THRESHOLD) {
			this.iterationProgressHistory.shift();
		}
	}

	/**
	 * Record whether a mutation tool failed during this iteration.
	 * Only the last MUTATION_FAILURE_ITERATION_THRESHOLD entries are retained.
	 */
	recordIterationMutationFailure(hadMutationFailure: boolean): void {
		this.iterationMutationFailureHistory.push(hadMutationFailure);
		if (this.iterationMutationFailureHistory.length > MUTATION_FAILURE_ITERATION_THRESHOLD) {
			this.iterationMutationFailureHistory.shift();
		}
	}

	/**
	 * Check if the last N tool calls are identical (exact same name + input).
	 * Returns the tool name if a doom loop is detected, undefined otherwise.
	 */
	isDoomLoop(): string | undefined {
		if (this.history.length < DOOM_LOOP_THRESHOLD) {
			return undefined;
		}

		const recent = this.history.slice(-DOOM_LOOP_THRESHOLD);
		const first = recent[0];

		const allIdentical = recent.every((call) => call.name === first.name && call.inputJson === first.inputJson);

		return allIdentical ? first.name : undefined;
	}

	/**
	 * Check if the same tool has been called N consecutive times (even with different inputs).
	 * This catches the agent retrying the same tool with slight variations.
	 * Read-only tools are excluded — it's normal to batch multiple file_read calls.
	 */
	isSameToolLoop(readOnlyTools?: ReadonlySet<string>): string | undefined {
		if (this.history.length < SAME_TOOL_THRESHOLD) {
			return undefined;
		}

		const recent = this.history.slice(-SAME_TOOL_THRESHOLD);
		const first = recent[0];

		// Skip read-only tools — batching reads is normal behavior
		if (readOnlyTools?.has(first.name)) {
			return undefined;
		}

		const allSameTool = recent.every((call) => call.name === first.name);

		return allSameTool ? first.name : undefined;
	}

	/**
	 * Check if the last N failures are consecutive failures of the same tool.
	 * Uses the dedicated failure history so interleaved successful read-only calls
	 * don't dilute the detection.
	 * Returns the tool name if a failure loop is detected, undefined otherwise.
	 */
	isFailureLoop(): string | undefined {
		if (this.failureHistory.length < FAILURE_LOOP_THRESHOLD) {
			return undefined;
		}

		const recent = this.failureHistory.slice(-FAILURE_LOOP_THRESHOLD);
		const first = recent[0];

		const allSameToolFailed = recent.every((record) => record.name === first.name);

		return allSameToolFailed ? first.name : undefined;
	}

	/**
	 * Check if the last N iterations had zero file changes.
	 * Returns true if no progress was made across N consecutive iterations.
	 */
	isNoProgress(): boolean {
		if (this.iterationProgressHistory.length < NO_PROGRESS_THRESHOLD) {
			return false;
		}

		const recent = this.iterationProgressHistory.slice(-NO_PROGRESS_THRESHOLD);
		return recent.every((hadProgress) => !hadProgress);
	}

	/**
	 * Check if mutation tools have failed in the last N consecutive iterations.
	 * This catches the pattern where the LLM keeps retrying a failing mutation
	 * (e.g. file_patch with hallucinated content) across iterations, even when
	 * interleaved with successful read-only calls.
	 */
	isMutationFailureLoop(): boolean {
		if (this.iterationMutationFailureHistory.length < MUTATION_FAILURE_ITERATION_THRESHOLD) {
			return false;
		}

		const recent = this.iterationMutationFailureHistory.slice(-MUTATION_FAILURE_ITERATION_THRESHOLD);
		return recent.every(Boolean);
	}

	/**
	 * Reset the history (e.g., when starting a new request).
	 */
	reset(): void {
		this.history = [];
		this.failureHistory = [];
		this.iterationProgressHistory = [];
		this.iterationMutationFailureHistory = [];
		this.totalToolCalls = 0;
	}

	/**
	 * Get the number of recorded tool calls.
	 */
	get length(): number {
		return this.totalToolCalls;
	}
}
