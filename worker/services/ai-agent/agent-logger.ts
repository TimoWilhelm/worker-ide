/**
 * Structured debug logger for the AI Agent loop.
 *
 * Captures detailed, machine-readable log entries at every decision point in the
 * agent loop — LLM calls, tool execution, response parsing, context pruning,
 * doom loop detection, retries, and errors.
 *
 * Logs are accumulated in-memory during the run (synchronous pushes only) and
 * flushed to `.agent/debug-logs/{id}.json` at the end of the run. The log ID is
 * sent to the frontend via a CUSTOM AG-UI event so the user can download it.
 *
 * Design principles:
 * - Zero async overhead during the hot path (all logging is synchronous array pushes)
 * - Tool inputs are sanitized (large content fields truncated) to keep logs manageable
 * - One log file per agent run, even on error/abort
 * - Old logs are cleaned up to avoid unbounded disk usage
 */

import fs from 'node:fs/promises';

// =============================================================================
// Constants
// =============================================================================

/** Maximum number of debug log files to keep per project. */
const MAX_DEBUG_LOGS = 20;

/** Maximum characters to include for large string fields in log data. */
const MAX_FIELD_LENGTH = 500;

/** Keys in tool inputs that commonly contain large content (file bodies, etc.). */
const LARGE_CONTENT_KEYS = new Set(['content', 'file_content', 'patch', 'diff', 'body', 'old_string', 'new_string']);

// =============================================================================
// Types
// =============================================================================

export type LogLevel = 'debug' | 'info' | 'warning' | 'error';

export type LogCategory = 'agent_loop' | 'llm' | 'tool_call' | 'tool_parse' | 'message' | 'snapshot' | 'context' | 'mcp';

export interface AgentLogEntry {
	/** ISO-8601 timestamp */
	timestamp: string;
	/** Monotonic elapsed milliseconds since the run started */
	elapsedMs: number;
	/** Severity level */
	level: LogLevel;
	/** Functional category */
	category: LogCategory;
	/** Specific event within the category */
	event: string;
	/** Structured data payload (varies by event) */
	data?: Record<string, unknown>;
	/** Current agent loop iteration (1-indexed), if applicable */
	iteration?: number;
	/** Duration of the operation in milliseconds, if applicable */
	durationMs?: number;
}

export interface AgentDebugLogSummary {
	totalIterations: number;
	totalToolCalls: number;
	toolCallsByName: Record<string, number>;
	totalErrors: number;
	totalWarnings: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	doomLoopDetected: boolean;
	hitIterationLimit: boolean;
	aborted: boolean;
}

export interface AgentDebugLog {
	/** Unique log identifier (used for download URL) */
	id: string;
	/** Session ID from the frontend (if provided) */
	sessionId: string | undefined;
	/** Project identifier */
	projectId: string;
	/** AI model used */
	model: string;
	/** Agent mode (code/plan/ask) */
	mode: string;
	/** ISO-8601 timestamp when the run started */
	startedAt: string;
	/** ISO-8601 timestamp when the run completed (set at flush time) */
	completedAt: string;
	/** Total run duration in milliseconds */
	totalDurationMs: number;
	/** Auto-computed summary statistics */
	summary: AgentDebugLogSummary;
	/** Ordered list of log entries */
	entries: AgentLogEntry[];
}

// =============================================================================
// Sanitization Helpers
// =============================================================================

/**
 * Truncate a string value, appending a size indicator if truncated.
 */
function truncateString(value: string, maxLength: number = MAX_FIELD_LENGTH): string {
	if (value.length <= maxLength) return value;
	return `${value.slice(0, maxLength)}... (${value.length} chars total)`;
}

/**
 * Sanitize tool input data for logging — truncate large content fields
 * to keep log files manageable while preserving enough context for debugging.
 */
export function sanitizeToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(input)) {
		if (LARGE_CONTENT_KEYS.has(key) && typeof value === 'string') {
			sanitized[key] = truncateString(value);
		} else if (typeof value === 'string' && value.length > MAX_FIELD_LENGTH * 2) {
			sanitized[key] = truncateString(value, MAX_FIELD_LENGTH * 2);
		} else {
			sanitized[key] = value;
		}
	}
	return sanitized;
}

/**
 * Summarize a tool result for logging — first N characters plus total length.
 */
export function summarizeToolResult(result: string): string {
	return truncateString(result);
}

// =============================================================================
// AgentLogger Class
// =============================================================================

export class AgentLogger {
	readonly id: string;
	private readonly entries: AgentLogEntry[] = [];
	private readonly startTime: number;
	private currentIteration = 0;

	// Summary tracking (updated incrementally to avoid recomputing)
	private toolCallCount = 0;
	private readonly toolCallCounts = new Map<string, number>();
	private errorCount = 0;
	private warningCount = 0;
	private totalInputTokens = 0;
	private totalOutputTokens = 0;
	private doomLoopDetected = false;
	private hitIterationLimit = false;
	private aborted = false;

	constructor(
		private readonly sessionId: string | undefined,
		private readonly projectId: string,
		private readonly model: string,
		private readonly mode: string,
	) {
		this.startTime = Date.now();
		const idPrefix = sessionId ?? crypto.randomUUID().slice(0, 8);
		this.id = `${idPrefix}-${this.startTime}`;
	}

	// =========================================================================
	// Core Logging
	// =========================================================================

	/**
	 * Append a log entry. This is synchronous — no I/O.
	 */
	log(level: LogLevel, category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		const entry: AgentLogEntry = {
			timestamp: new Date().toISOString(),
			elapsedMs: Date.now() - this.startTime,
			level,
			category,
			event,
			...(data !== undefined && { data }),
			...(this.currentIteration > 0 && { iteration: this.currentIteration }),
			...(options?.durationMs !== undefined && { durationMs: options.durationMs }),
		};
		this.entries.push(entry);

		// Update summary counters
		if (level === 'error') this.errorCount++;
		if (level === 'warning') this.warningCount++;
	}

	/** Convenience: debug-level log */
	debug(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('debug', category, event, data, options);
	}

	/** Convenience: info-level log */
	info(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('info', category, event, data, options);
	}

	/** Convenience: warning-level log */
	warn(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('warning', category, event, data, options);
	}

	/** Convenience: error-level log */
	error(category: LogCategory, event: string, data?: Record<string, unknown>, options?: { durationMs?: number }): void {
		this.log('error', category, event, data, options);
	}

	// =========================================================================
	// Iteration Tracking
	// =========================================================================

	/** Set the current iteration number (1-indexed). */
	setIteration(iteration: number): void {
		this.currentIteration = iteration;
	}

	// =========================================================================
	// Summary Tracking
	// =========================================================================

	/** Record a completed tool call (updates summary counters). */
	recordToolCall(toolName: string): void {
		this.toolCallCount++;
		this.toolCallCounts.set(toolName, (this.toolCallCounts.get(toolName) ?? 0) + 1);
	}

	/** Record token usage from an LLM call. */
	recordTokenUsage(inputTokens: number, outputTokens: number): void {
		this.totalInputTokens += inputTokens;
		this.totalOutputTokens += outputTokens;
	}

	/** Mark that a doom loop was detected. */
	markDoomLoop(): void {
		this.doomLoopDetected = true;
	}

	/** Mark that the iteration limit was hit. */
	markIterationLimit(): void {
		this.hitIterationLimit = true;
	}

	/** Mark that the run was aborted. */
	markAborted(): void {
		this.aborted = true;
	}

	// =========================================================================
	// Timer Helper
	// =========================================================================

	/**
	 * Start a timer. Returns a function that, when called, returns the elapsed
	 * milliseconds since the timer was started.
	 */
	startTimer(): () => number {
		const start = Date.now();
		return () => Date.now() - start;
	}

	// =========================================================================
	// Serialization
	// =========================================================================

	/**
	 * Build the complete debug log document.
	 */
	toJSON(): AgentDebugLog {
		const now = Date.now();
		const toolCallsByName: Record<string, number> = {};
		for (const [name, count] of this.toolCallCounts) {
			toolCallsByName[name] = count;
		}

		return {
			id: this.id,
			sessionId: this.sessionId,
			projectId: this.projectId,
			model: this.model,
			mode: this.mode,
			startedAt: new Date(this.startTime).toISOString(),
			completedAt: new Date(now).toISOString(),
			totalDurationMs: now - this.startTime,
			summary: {
				totalIterations: this.currentIteration,
				totalToolCalls: this.toolCallCount,
				toolCallsByName,
				totalErrors: this.errorCount,
				totalWarnings: this.warningCount,
				totalInputTokens: this.totalInputTokens,
				totalOutputTokens: this.totalOutputTokens,
				doomLoopDetected: this.doomLoopDetected,
				hitIterationLimit: this.hitIterationLimit,
				aborted: this.aborted,
			},
			entries: this.entries,
		};
	}

	// =========================================================================
	// Persistence
	// =========================================================================

	/**
	 * Flush the debug log to disk at `.agent/debug-logs/{id}.json`.
	 * Also cleans up old logs beyond the retention limit.
	 *
	 * This is the ONLY async operation — called once at the end of the run.
	 */
	async flush(projectRoot: string): Promise<void> {
		const logsDirectory = `${projectRoot}/.agent/debug-logs`;

		try {
			await fs.mkdir(logsDirectory, { recursive: true });

			const logData = this.toJSON();
			// eslint-disable-next-line unicorn/no-null -- JSON.stringify requires null as replacer argument
			await fs.writeFile(`${logsDirectory}/${this.id}.json`, JSON.stringify(logData, null, 2));

			await this.cleanupOldLogs(logsDirectory);
		} catch (error) {
			// Non-fatal — don't let logging failures break the agent
			console.error('Failed to flush agent debug log:', error);
		}
	}

	/**
	 * Remove old debug log files beyond the retention limit.
	 */
	private async cleanupOldLogs(logsDirectory: string): Promise<void> {
		try {
			const entries = await fs.readdir(logsDirectory);
			const logFiles = entries
				.filter((entry) => entry.endsWith('.json'))
				.toSorted((a, b) => {
					// Log files are named {prefix}-{timestamp}.json — sort by the numeric timestamp suffix.
					const timestampA = Number(a.slice(0, -5).split('-').pop()) || 0;
					const timestampB = Number(b.slice(0, -5).split('-').pop()) || 0;
					return timestampA - timestampB;
				});

			// Remove the oldest log files beyond the retention limit.
			if (logFiles.length > MAX_DEBUG_LOGS) {
				const toRemove = logFiles.slice(0, logFiles.length - MAX_DEBUG_LOGS);
				for (const file of toRemove) {
					try {
						await fs.unlink(`${logsDirectory}/${file}`);
					} catch {
						// Non-fatal
					}
				}
			}
		} catch {
			// Non-fatal
		}
	}
}
