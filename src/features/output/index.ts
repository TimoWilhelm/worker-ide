/**
 * Output Feature Barrel Export
 */

export { OutputPanel } from './components/output-panel';
export { clearLogs, getLogSnapshot, useLogs } from './lib/log-buffer';
export type { LogCounts, LogEntry, OutputPanelProperties } from './types';

// Default export for React.lazy()
export { OutputPanel as default } from './components/output-panel';
