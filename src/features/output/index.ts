export { OutputPanel } from './components/output-panel';
export { clearLogs, getLogSnapshot, setActiveLogProject, useLogs } from './lib/log-buffer';
export type { LogCounts, LogEntry, OutputPanelProperties } from './types';

// Default export for React.lazy()
export { OutputPanel as default } from './components/output-panel';
