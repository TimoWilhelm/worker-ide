/**
 * Doom loop detection for the AI agent.
 * Ported from OpenCode's SessionProcessor — detects when the agent makes
 * identical consecutive tool calls, indicating it's stuck in a loop.
 */

// =============================================================================
// Constants
// =============================================================================

/**
 * Number of consecutive identical tool calls required to trigger doom loop detection.
 */
const DOOM_LOOP_THRESHOLD = 3;

// =============================================================================
// Types
// =============================================================================

interface ToolCallRecord {
	name: string;
	inputJson: string;
}

// =============================================================================
// Doom Loop Detector
// =============================================================================

/**
 * Tracks tool calls and detects doom loops (repeated identical tool calls).
 *
 * Usage:
 * 1. Call `record()` after each tool call completes.
 * 2. Call `isDoomLoop()` to check if the last N calls were identical.
 * 3. Call `reset()` to clear history (e.g., when starting a new agent turn).
 */
export class DoomLoopDetector {
	private history: ToolCallRecord[] = [];

	/**
	 * Record a completed tool call.
	 */
	record(toolName: string, input: unknown): void {
		this.history.push({
			name: toolName,
			inputJson: JSON.stringify(input),
		});
	}

	/**
	 * Check if the last N tool calls are identical (doom loop).
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
	 * Reset the history (e.g., when starting a new request).
	 */
	reset(): void {
		this.history = [];
	}

	/**
	 * Get the number of recorded tool calls.
	 */
	get length(): number {
		return this.history.length;
	}
}
