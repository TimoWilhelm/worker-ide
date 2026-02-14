/**
 * Log Buffer
 *
 * Module-level log accumulator that listens for server-error, rebuild,
 * and server-logs CustomEvents. Persists across terminal component
 * mount/unmount cycles so no log entries are lost.
 *
 * Logs are cleared on each rebuild by default unless "Preserve Logs"
 * is enabled.
 */

import type { LogEntry } from '../types';
import type { ServerError, ServerLogEntry } from '@shared/types';

// =============================================================================
// State
// =============================================================================

let idCounter = 0;
let entries: LogEntry[] = [];
let preserveLogs = false;
const listeners = new Set<() => void>();

function nextId(): string {
	idCounter++;
	return `log-${idCounter}`;
}

function notify() {
	for (const listener of listeners) {
		listener();
	}
}

function append(...newEntries: LogEntry[]) {
	entries = [...entries, ...newEntries];
	notify();
}

// =============================================================================
// Event Listeners (always active once this module is imported)
// =============================================================================

globalThis.addEventListener('server-error', (event: Event) => {
	if (event instanceof CustomEvent) {
		const error: ServerError = event.detail;
		const parts = [error.message];
		if (error.file) {
			parts.push(`  at ${error.file}${error.line ? `:${error.line}` : ''}${error.column ? `:${error.column}` : ''}`);
		}
		append({
			id: nextId(),
			timestamp: error.timestamp,
			level: 'error',
			message: parts.join('\n'),
			source: 'server',
		});
	}
});

globalThis.addEventListener('rebuild', () => {
	// Clear logs on rebuild unless preserving
	if (!preserveLogs) {
		entries = [];
		notify();
	}
});

globalThis.addEventListener('server-logs', (event: Event) => {
	if (event instanceof CustomEvent) {
		const logs: ServerLogEntry[] = event.detail;
		append(
			...logs.map((log) => ({
				id: nextId(),
				timestamp: log.timestamp,
				level: log.level,
				message: log.message,
				source: 'server' as const,
			})),
		);
	}
});

/**
 * Listen for postMessage events from the preview iframe:
 * - __console-log: forwarded by chobitsu CDP Runtime.consoleAPICalled events
 * - __server-error: forwarded by the HMR client when the preview receives a server error
 */
globalThis.addEventListener('message', (event: MessageEvent) => {
	// Only accept messages from same origin (preview iframe)
	if (event.origin !== globalThis.location.origin) return;

	const { type } = event.data ?? {};

	if (type === '__console-log') {
		const { level, message, timestamp } = event.data;
		if (typeof message !== 'string' || typeof timestamp !== 'number') return;

		const validLevels = new Set(['log', 'info', 'warn', 'error', 'debug']);
		const resolvedLevel: LogEntry['level'] = validLevels.has(level) ? level : 'log';

		append({
			id: nextId(),
			timestamp,
			level: resolvedLevel,
			message,
			source: 'client',
		});
		return;
	}

	if (type === '__server-error') {
		const error = event.data.error;
		if (!error || typeof error.message !== 'string') return;

		const parts = [error.message];
		if (error.file) {
			parts.push(`  at ${error.file}${error.line ? `:${error.line}` : ''}${error.column ? `:${error.column}` : ''}`);
		}
		append({
			id: nextId(),
			timestamp: error.timestamp ?? Date.now(),
			level: 'error',
			message: parts.join('\n'),
			source: 'client',
		});
	}
});

// =============================================================================
// Public API (useSyncExternalStore compatible)
// =============================================================================

export function subscribeToLogs(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function getLogSnapshot(): LogEntry[] {
	return entries;
}

export function clearLogs(): void {
	entries = [];
	notify();
}

export function getPreserveLogs(): boolean {
	return preserveLogs;
}

export function setPreserveLogs(value: boolean): void {
	preserveLogs = value;
}
