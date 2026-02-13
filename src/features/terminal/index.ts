/**
 * Terminal Feature Barrel Export
 */

export { TerminalPanel } from './components/terminal-panel';
export { clearLogs, getLogSnapshot, subscribeToLogs } from './lib/log-buffer';
export type { LogCounts, LogEntry, TerminalPanelProperties } from './types';

// Default export for React.lazy()
export { TerminalPanel as default } from './components/terminal-panel';
