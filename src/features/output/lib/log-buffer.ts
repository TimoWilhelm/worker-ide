/**
 * Log Buffer
 *
 * Zustand store that listens for server-error, rebuild, and server-logs
 * CustomEvents. Persists across output panel component mount/unmount
 * cycles so no log entries are lost.
 *
 * Logs are cleared on each rebuild by default unless "Preserve Logs"
 * is enabled.
 */

import { createStore, useStore } from 'zustand';

import type { LogEntry } from '../types';
import type { ServerError, ServerLogEntry } from '@shared/types';

// =============================================================================
// Store
// =============================================================================

interface LogBufferState {
	entries: LogEntry[];
	preserveLogs: boolean;
}

let idCounter = 0;
const seenErrorIds = new Set<string>();

function nextId(): string {
	idCounter++;
	return `log-${idCounter}`;
}

const logBufferStore = createStore<LogBufferState>(() => ({
	entries: [],
	preserveLogs: false,
}));

function append(...newEntries: LogEntry[]) {
	logBufferStore.setState((state) => ({
		entries: [...state.entries, ...newEntries],
	}));
}

function clearIfNotPreserving() {
	const { preserveLogs } = logBufferStore.getState();
	if (!preserveLogs) {
		seenErrorIds.clear();
		logBufferStore.setState({ entries: [] });
	}
}

// =============================================================================
// Event Listeners (always active once this module is imported)
// =============================================================================

globalThis.addEventListener('server-error', (event: Event) => {
	if (event instanceof CustomEvent) {
		const error: ServerError = event.detail;
		if (error.id && seenErrorIds.has(error.id)) return;
		if (error.id) seenErrorIds.add(error.id);
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
	clearIfNotPreserving();
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
 * Clear logs on manual preview refresh unless preserving.
 */
globalThis.addEventListener('preview-refresh', () => {
	clearIfNotPreserving();
});

/**
 * Listen for lint-diagnostics events dispatched by the Biome lint extension.
 * Replaces previous lint entries for the same file with the new diagnostics.
 */
interface LintDiagnosticEvent {
	filePath: string;
	diagnostics: Array<{
		message: string;
		severity: string;
		from: number;
		rule?: string;
	}>;
}

function isLintDiagnosticEvent(value: unknown): value is LintDiagnosticEvent {
	if (typeof value !== 'object' || value === undefined || value === null) return false;
	if (!('filePath' in value) || !('diagnostics' in value)) return false;
	const { filePath, diagnostics } = value;
	return typeof filePath === 'string' && Array.isArray(diagnostics);
}

globalThis.addEventListener('lint-diagnostics', (event: Event) => {
	if (!(event instanceof CustomEvent)) return;
	if (!isLintDiagnosticEvent(event.detail)) return;

	const { filePath, diagnostics } = event.detail;

	// Remove previous lint entries for this file
	logBufferStore.setState((state) => ({
		entries: state.entries.filter((entry) => !(entry.source === 'lint' && entry.message.includes(filePath))),
	}));

	if (diagnostics.length === 0) return;

	const newEntries: LogEntry[] = diagnostics.map((diagnostic) => ({
		id: nextId(),
		timestamp: Date.now(),
		level: diagnostic.severity === 'error' ? ('error' as const) : ('warn' as const),
		message: `${filePath}:${diagnostic.from} ${diagnostic.rule ? `(${diagnostic.rule}) ` : ''}${diagnostic.message}`,
		source: 'lint' as const,
	}));

	append(...newEntries);
});

/**
 * Listen for postMessage events from the preview iframe:
 * - __console-log: forwarded by chobitsu CDP Runtime.consoleAPICalled events
 * - __server-error: forwarded by the preview HMR client when it receives a server error
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
		if (error.id && seenErrorIds.has(error.id)) return;
		if (error.id) seenErrorIds.add(error.id);

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
// Public API
// =============================================================================

/** React hook — subscribe to the log entries array. */
export function useLogs(): LogEntry[] {
	return useStore(logBufferStore, (state) => state.entries);
}

export function clearLogs(): void {
	seenErrorIds.clear();
	logBufferStore.setState({ entries: [] });
}

export function getPreserveLogs(): boolean {
	return logBufferStore.getState().preserveLogs;
}

export function setPreserveLogs(value: boolean): void {
	logBufferStore.setState({ preserveLogs: value });
}

/**
 * Return a formatted snapshot of recent log entries for AI agent context.
 * Caps output at `maxEntries` entries and `maxBytes` total characters.
 */
const LOG_SNAPSHOT_MAX_ENTRIES = 50;
const LOG_SNAPSHOT_MAX_BYTES = 8192;

export function getLogSnapshot(maxEntries = LOG_SNAPSHOT_MAX_ENTRIES, maxBytes = LOG_SNAPSHOT_MAX_BYTES): string {
	const { entries } = logBufferStore.getState();
	if (entries.length === 0) return '';

	const recent = entries.slice(-maxEntries);
	const lines: string[] = [];
	let totalLength = 0;

	for (const entry of recent) {
		const time = new Date(entry.timestamp).toLocaleTimeString('en-US', {
			hour12: false,
			hour: '2-digit',
			minute: '2-digit',
			second: '2-digit',
		});
		const source = entry.source ? `[${entry.source}]` : '';
		const line = `${time} ${source} ${entry.level.toUpperCase()}: ${entry.message}`;

		if (totalLength + line.length > maxBytes) break;
		lines.push(line);
		totalLength += line.length;
	}

	return lines.join('\n');
}
