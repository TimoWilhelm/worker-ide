/**
 * Tests for the log buffer's getLogSnapshot() function.
 */

import { afterEach, describe, expect, it } from 'vitest';

import { clearLogs, getLogSnapshot } from './log-buffer';

// The log buffer listens for CustomEvents on globalThis.
// We can push entries by dispatching 'server-logs' events.

function dispatchServerLogs(logs: Array<{ level: string; message: string }>) {
	const entries = logs.map((log) => ({
		type: 'server-log' as const,
		timestamp: Date.now(),
		level: log.level,
		message: log.message,
	}));
	globalThis.dispatchEvent(new CustomEvent('server-logs', { detail: entries }));
}

describe('getLogSnapshot', () => {
	afterEach(() => {
		clearLogs();
	});

	it('returns empty string when there are no logs', () => {
		expect(getLogSnapshot()).toBe('');
	});

	it('returns formatted log entries', () => {
		dispatchServerLogs([
			{ level: 'error', message: 'Build failed: missing export' },
			{ level: 'log', message: 'Server started on port 3000' },
		]);

		const snapshot = getLogSnapshot();
		expect(snapshot).toContain('[server] ERROR: Build failed: missing export');
		expect(snapshot).toContain('[server] LOG: Server started on port 3000');
	});

	it('respects maxEntries limit', () => {
		const logs = Array.from({ length: 10 }, (_, index) => ({
			level: 'log',
			message: `Log entry ${index}`,
		}));
		dispatchServerLogs(logs);

		const snapshot = getLogSnapshot(3);
		// Should only contain the last 3 entries (slice(-3))
		const lines = snapshot.split('\n');
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain('Log entry 7');
		expect(lines[1]).toContain('Log entry 8');
		expect(lines[2]).toContain('Log entry 9');
	});

	it('respects maxBytes limit', () => {
		dispatchServerLogs([
			{ level: 'log', message: 'A'.repeat(100) },
			{ level: 'log', message: 'B'.repeat(100) },
			{ level: 'log', message: 'C'.repeat(100) },
		]);

		// Set a small byte limit that can only fit ~1 entry
		const snapshot = getLogSnapshot(50, 150);
		const lines = snapshot.split('\n');
		expect(lines.length).toBeLessThanOrEqual(2);
	});

	it('includes source tag in output', () => {
		dispatchServerLogs([{ level: 'warning', message: 'Deprecation warning' }]);

		const snapshot = getLogSnapshot();
		expect(snapshot).toContain('[server]');
		expect(snapshot).toContain('WARNING:');
	});
});
