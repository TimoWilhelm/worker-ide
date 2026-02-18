/**
 * Token usage tracking for the AI agent.
 * Tracks per-turn and cumulative token counts from the Anthropic API responses.
 */

// =============================================================================
// Types
// =============================================================================

export interface TokenUsage {
	/** Input tokens consumed */
	input: number;
	/** Output tokens generated */
	output: number;
	/** Tokens read from cache */
	cacheRead: number;
	/** Tokens written to cache */
	cacheWrite: number;
}

export interface TurnUsage {
	/** Turn number (1-indexed) */
	turn: number;
	/** Token usage for this turn */
	usage: TokenUsage;
	/** Model that was used */
	model: string;
}

// =============================================================================
// Token Tracker
// =============================================================================

/**
 * Tracks token usage across agent turns.
 *
 * Usage:
 * 1. Call `recordTurn()` after each LLM call with the usage data from the response.
 * 2. Call `getTotalUsage()` to get cumulative usage.
 * 3. Call `getTurns()` to get per-turn breakdown.
 */
export class TokenTracker {
	private turns: TurnUsage[] = [];

	/**
	 * Record token usage for a completed LLM turn.
	 */
	recordTurn(
		model: string,
		usage: {
			inputTokens?: number;
			outputTokens?: number;
			cacheReadInputTokens?: number;
			cacheCreationInputTokens?: number;
		},
	): void {
		this.turns.push({
			turn: this.turns.length + 1,
			model,
			usage: {
				input: usage.inputTokens ?? 0,
				output: usage.outputTokens ?? 0,
				cacheRead: usage.cacheReadInputTokens ?? 0,
				cacheWrite: usage.cacheCreationInputTokens ?? 0,
			},
		});
	}

	/**
	 * Get cumulative token usage across all turns.
	 */
	getTotalUsage(): TokenUsage {
		const total: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
		for (const turn of this.turns) {
			total.input += turn.usage.input;
			total.output += turn.usage.output;
			total.cacheRead += turn.usage.cacheRead;
			total.cacheWrite += turn.usage.cacheWrite;
		}
		return total;
	}

	/**
	 * Get per-turn usage breakdown.
	 */
	getTurns(): readonly TurnUsage[] {
		return this.turns;
	}

	/**
	 * Get the number of recorded turns.
	 */
	get turnCount(): number {
		return this.turns.length;
	}

	/**
	 * Reset tracking (e.g., for a new session).
	 */
	reset(): void {
		this.turns = [];
	}
}
