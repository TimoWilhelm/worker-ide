import { afterEach, describe, expect, it } from 'vitest';

import { clearLogs, getLogSnapshot, setActiveLogProject } from './log-buffer';

// The log buffer listens for CustomEvents on globalThis.
// We can push entries by dispatching 'server-logs' events.

function dispatchServerLogs(logs: Array<{ level: string; message: string; location?: { file: string; line?: number; column?: number } }>) {
	const entries = logs.map((log) => ({
		type: 'server-log' as const,
		timestamp: Date.now(),
		level: log.level,
		message: log.message,
		location: log.location,
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

	it('includes structured server log locations in snapshots', () => {
		dispatchServerLogs([
			{
				level: 'error',
				message: 'Worker crashed',
				location: { file: 'worker/index.ts', line: 12, column: 8 },
			},
		]);

		const snapshot = getLogSnapshot();
		expect(snapshot).toContain('ERROR: Worker crashed');
		expect(snapshot).toContain('  at worker/index.ts:12:8');
	});

	it('uses structured server-error locations instead of mutating the message', () => {
		globalThis.dispatchEvent(
			new CustomEvent('server-error', {
				detail: {
					id: 'error-1',
					timestamp: Date.now(),
					type: 'runtime',
					message: 'ReferenceError: asdasda is not defined',
					location: { file: 'worker/index.ts', line: 3, column: 5 },
				},
			}),
		);

		const snapshot = getLogSnapshot();
		expect(snapshot).toContain('ERROR: ReferenceError: asdasda is not defined');
		expect(snapshot).toContain('  at worker/index.ts:3:5');
	});

	it('includes structured lint diagnostic locations in snapshots', () => {
		globalThis.dispatchEvent(
			new CustomEvent('lint-diagnostics', {
				detail: {
					filePath: 'src/app.ts',
					diagnostics: [
						{
							message: 'Unexpected var, use let or const instead.',
							severity: 'error',
							line: 2,
							column: 7,
							rule: 'lint/style/noVar',
						},
					],
				},
			}),
		);

		const snapshot = getLogSnapshot();
		expect(snapshot).toContain('[lint] ERROR: (lint/style/noVar) Unexpected var, use let or const instead.');
		expect(snapshot).toContain('  at src/app.ts:2:7');
	});
});

describe('setActiveLogProject', () => {
	afterEach(() => {
		clearLogs();
		// Reset module state so each test starts from a known active project.
		setActiveLogProject('reset-sentinel');
	});

	it('clears buffered logs when the active project changes', () => {
		setActiveLogProject('project-a');
		dispatchServerLogs([{ level: 'log', message: 'from project A' }]);
		expect(getLogSnapshot()).toContain('from project A');

		// Switching to a different project drops the previous project's logs.
		setActiveLogProject('project-b');
		expect(getLogSnapshot()).toBe('');
	});

	it('does not clear logs when set to the same project (idempotent)', () => {
		setActiveLogProject('project-c');
		dispatchServerLogs([{ level: 'log', message: 'stays for project C' }]);

		setActiveLogProject('project-c');
		expect(getLogSnapshot()).toContain('stays for project C');
	});
});
