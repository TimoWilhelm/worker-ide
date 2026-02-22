/**
 * Unit tests for AgentLogger.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentLogger, sanitizeToolInput, summarizeToolResult } from './agent-logger';

import type { AgentDebugLog } from './agent-logger';

// =============================================================================
// Mock node:fs/promises — agent-logger imports it for flush/cleanup
// =============================================================================

vi.mock('node:fs/promises', () => ({
	default: {
		mkdir: vi.fn().mockResolvedValue(true),
		writeFile: vi.fn().mockResolvedValue(true),
		readdir: vi.fn().mockResolvedValue([]),
		unlink: vi.fn().mockResolvedValue(true),
	},
}));

// =============================================================================
// Tests
// =============================================================================

describe('AgentLogger', () => {
	let logger: AgentLogger;

	beforeEach(() => {
		logger = new AgentLogger('test-session', 'test-project', 'anthropic/claude-4.5-haiku', 'code');
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	// =========================================================================
	// Constructor and ID generation
	// =========================================================================

	describe('constructor', () => {
		it('generates an ID from sessionId and timestamp', () => {
			expect(logger.id).toMatch(/^test-session-\d+$/);
		});

		it('generates a UUID-based ID when no sessionId is provided', () => {
			const noSessionLogger = new AgentLogger(undefined, 'proj', 'model', 'code');
			// Should be 8 hex chars + hyphen + timestamp digits
			expect(noSessionLogger.id).toMatch(/^[\da-f]{8}-\d+$/);
		});
	});

	// =========================================================================
	// Logging entries
	// =========================================================================

	describe('log', () => {
		it('appends an entry with correct structure', () => {
			logger.log('info', 'agent_loop', 'started', { mode: 'code' });
			const result = logger.toJSON();
			expect(result.entries).toHaveLength(1);

			const entry = result.entries[0];
			expect(entry.level).toBe('info');
			expect(entry.category).toBe('agent_loop');
			expect(entry.event).toBe('started');
			expect(entry.data).toEqual({ mode: 'code' });
			expect(entry.timestamp).toBeTruthy();
			expect(typeof entry.elapsedMs).toBe('number');
		});

		it('includes iteration when set', () => {
			logger.setIteration(3);
			logger.info('agent_loop', 'iteration_start');
			const entry = logger.toJSON().entries[0];
			expect(entry.iteration).toBe(3);
		});

		it('does not include iteration when not set', () => {
			logger.info('agent_loop', 'started');
			const entry = logger.toJSON().entries[0];
			expect(entry.iteration).toBeUndefined();
		});

		it('includes durationMs when provided', () => {
			logger.info('tool_call', 'completed', { toolName: 'file_read' }, { durationMs: 42 });
			const entry = logger.toJSON().entries[0];
			expect(entry.durationMs).toBe(42);
		});

		it('does not include data when undefined', () => {
			logger.debug('agent_loop', 'iteration_start');
			const entry = logger.toJSON().entries[0];
			expect(entry.data).toBeUndefined();
		});
	});

	// =========================================================================
	// Convenience methods
	// =========================================================================

	describe('convenience methods', () => {
		it('debug() creates debug-level entries', () => {
			logger.debug('llm', 'prompt_built', { length: 100 });
			expect(logger.toJSON().entries[0].level).toBe('debug');
		});

		it('info() creates info-level entries', () => {
			logger.info('tool_call', 'started');
			expect(logger.toJSON().entries[0].level).toBe('info');
		});

		it('warn() creates warning-level entries and increments warning count', () => {
			logger.warn('tool_parse', 'empty_name');
			const result = logger.toJSON();
			expect(result.entries[0].level).toBe('warning');
			expect(result.summary.totalWarnings).toBe(1);
		});

		it('error() creates error-level entries and increments error count', () => {
			logger.error('agent_loop', 'error', { message: 'boom' });
			const result = logger.toJSON();
			expect(result.entries[0].level).toBe('error');
			expect(result.summary.totalErrors).toBe(1);
		});
	});

	// =========================================================================
	// Summary tracking
	// =========================================================================

	describe('summary tracking', () => {
		it('tracks tool calls by name', () => {
			logger.recordToolCall('file_read');
			logger.recordToolCall('file_read');
			logger.recordToolCall('file_write');
			const summary = logger.toJSON().summary;
			expect(summary.totalToolCalls).toBe(3);
			expect(summary.toolCallsByName).toEqual({ file_read: 2, file_write: 1 });
		});

		it('tracks token usage cumulatively', () => {
			logger.recordTokenUsage(1000, 500);
			logger.recordTokenUsage(2000, 300);
			const summary = logger.toJSON().summary;
			expect(summary.totalInputTokens).toBe(3000);
			expect(summary.totalOutputTokens).toBe(800);
		});

		it('tracks doom loop detection', () => {
			expect(logger.toJSON().summary.doomLoopDetected).toBe(false);
			logger.markDoomLoop();
			expect(logger.toJSON().summary.doomLoopDetected).toBe(true);
		});

		it('tracks iteration limit', () => {
			expect(logger.toJSON().summary.hitIterationLimit).toBe(false);
			logger.markIterationLimit();
			expect(logger.toJSON().summary.hitIterationLimit).toBe(true);
		});

		it('tracks abort', () => {
			expect(logger.toJSON().summary.aborted).toBe(false);
			logger.markAborted();
			expect(logger.toJSON().summary.aborted).toBe(true);
		});

		it('counts errors and warnings from log entries', () => {
			logger.error('agent_loop', 'error');
			logger.error('llm', 'stream_error');
			logger.warn('tool_parse', 'parse_error');
			const summary = logger.toJSON().summary;
			expect(summary.totalErrors).toBe(2);
			expect(summary.totalWarnings).toBe(1);
		});

		it('tracks total iterations via setIteration', () => {
			logger.setIteration(1);
			logger.setIteration(2);
			logger.setIteration(5);
			expect(logger.toJSON().summary.totalIterations).toBe(5);
		});
	});

	// =========================================================================
	// Timer
	// =========================================================================

	describe('startTimer', () => {
		it('returns a function that measures elapsed time', async () => {
			const elapsed = logger.startTimer();
			// Wait a tiny bit to ensure measurable time
			await new Promise((resolve) => {
				setTimeout(resolve, 10);
			});
			const ms = elapsed();
			expect(ms).toBeGreaterThanOrEqual(5); // Allow some variance
			expect(ms).toBeLessThan(1000);
		});
	});

	// =========================================================================
	// Serialization (toJSON)
	// =========================================================================

	describe('toJSON', () => {
		it('produces a valid AgentDebugLog document', () => {
			logger.info('agent_loop', 'started');
			logger.recordToolCall('file_read');

			const result: AgentDebugLog = logger.toJSON();

			expect(result.id).toBeTruthy();
			expect(result.sessionId).toBe('test-session');
			expect(result.projectId).toBe('test-project');
			expect(result.model).toBe('anthropic/claude-4.5-haiku');
			expect(result.mode).toBe('code');
			expect(result.startedAt).toBeTruthy();
			expect(result.completedAt).toBeTruthy();
			expect(typeof result.totalDurationMs).toBe('number');
			expect(result.entries).toHaveLength(1);
			expect(result.summary.totalToolCalls).toBe(1);
		});

		it('includes all entries in order', () => {
			logger.info('agent_loop', 'started');
			logger.debug('llm', 'prompt_built');
			logger.info('tool_call', 'started');
			logger.error('agent_loop', 'error');

			const entries = logger.toJSON().entries;
			expect(entries).toHaveLength(4);
			expect(entries[0].event).toBe('started');
			expect(entries[1].event).toBe('prompt_built');
			expect(entries[2].event).toBe('started');
			expect(entries[3].event).toBe('error');
		});
	});

	// =========================================================================
	// Flush (persistence)
	// =========================================================================

	describe('flush', () => {
		it('calls mkdir and writeFile with session-scoped paths', async () => {
			const fs = await import('node:fs/promises');
			logger.info('agent_loop', 'started');

			await logger.flush('/project');

			expect(fs.default.mkdir).toHaveBeenCalledWith('/project/.agent/sessions/test-session/debug-logs', { recursive: true });
			expect(fs.default.writeFile).toHaveBeenCalledWith(
				expect.stringMatching(/^\/project\/\.agent\/sessions\/test-session\/debug-logs\/test-session-\d+\.json$/),
				expect.any(String),
			);
		});

		it('falls back to project-scoped path when no sessionId is provided', async () => {
			const fs = await import('node:fs/promises');
			const noSessionLogger = new AgentLogger(undefined, 'proj', 'model', 'code');
			noSessionLogger.info('agent_loop', 'started');

			await noSessionLogger.flush('/project');

			expect(fs.default.mkdir).toHaveBeenCalledWith('/project/.agent/debug-logs', { recursive: true });
		});

		it('writes valid JSON content', async () => {
			const fs = await import('node:fs/promises');
			logger.info('agent_loop', 'completed');

			await logger.flush('/project');

			const writeCall = vi.mocked(fs.default.writeFile).mock.calls[0];
			const content = String(writeCall[1]);
			const parsed = JSON.parse(content);
			expect(parsed.id).toBeTruthy();
			expect(parsed.entries).toHaveLength(1);
		});

		it('does not throw on filesystem errors', async () => {
			const fs = await import('node:fs/promises');
			vi.mocked(fs.default.mkdir).mockRejectedValue(new Error('Permission denied'));

			// Should not throw
			await expect(logger.flush('/project')).resolves.toBeUndefined();
		});

		it('cleans up old logs beyond the retention limit', async () => {
			const fs = await import('node:fs/promises');
			// Simulate 25 existing log files with realistic timestamp-based names.
			// Prefixes vary so lexicographic sort would NOT match chronological order.
			const existingFiles = Array.from({ length: 25 }, (_, index) => {
				const prefix = String.fromCodePoint(122 - (index % 26)); // z, y, x, ...
				return `${prefix}-${1000 + index}.json`;
			});
			// eslint-disable-next-line @typescript-eslint/consistent-type-assertions, @typescript-eslint/no-explicit-any -- readdir mock needs string[] but TS expects Dirent[]
			vi.mocked(fs.default.readdir).mockResolvedValue(existingFiles as any);

			await logger.flush('/project');

			// Should remove the 5 oldest files by timestamp (timestamps 1000–1004)
			expect(fs.default.unlink).toHaveBeenCalledTimes(5);
			const removedFiles = vi.mocked(fs.default.unlink).mock.calls.map((call) => String(call[0]));
			for (const file of removedFiles) {
				const timestamp = Number(file.slice(0, -5).split('-').pop());
				expect(timestamp).toBeLessThan(1005);
			}
		});
	});
});

// =============================================================================
// sanitizeToolInput
// =============================================================================

describe('sanitizeToolInput', () => {
	it('passes through short values unchanged', () => {
		const input = { path: '/src/app.ts', pattern: '*.ts' };
		expect(sanitizeToolInput(input)).toEqual(input);
	});

	it('truncates known large content keys', () => {
		const longContent = 'x'.repeat(1000);
		const result = sanitizeToolInput({ path: '/file.ts', content: longContent });
		expect(typeof result.content).toBe('string');
		const contentString = String(result.content);
		expect(contentString.length).toBeLessThan(longContent.length);
		expect(contentString).toContain('1000 chars total');
	});

	it('truncates very long unknown keys', () => {
		const longValue = 'y'.repeat(2000);
		const result = sanitizeToolInput({ description: longValue });
		const descriptionString = String(result.description);
		expect(descriptionString.length).toBeLessThan(longValue.length);
		expect(descriptionString).toContain('2000 chars total');
	});

	it('does not truncate moderately long unknown keys', () => {
		const moderateValue = 'z'.repeat(800);
		const result = sanitizeToolInput({ description: moderateValue });
		expect(result.description).toBe(moderateValue);
	});
});

// =============================================================================
// summarizeToolResult
// =============================================================================

describe('summarizeToolResult', () => {
	it('returns short results unchanged', () => {
		expect(summarizeToolResult('Success')).toBe('Success');
	});

	it('truncates long results', () => {
		const longResult = 'a'.repeat(1000);
		const summary = summarizeToolResult(longResult);
		expect(summary.length).toBeLessThan(longResult.length);
		expect(summary).toContain('1000 chars total');
	});
});
