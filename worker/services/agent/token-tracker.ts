export interface TokenUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface TurnUsage {
	turn: number;
	usage: TokenUsage;
	model: string;
}

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
	getTurns(): readonly TurnUsage[] {
		return this.turns;
	}
	get turnCount(): number {
		return this.turns.length;
	}
	reset(): void {
		this.turns = [];
	}
}
