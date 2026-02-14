/**
 * Terminal Feature Types
 */

export interface TerminalPanelProperties {
	/** Project ID for log subscription */
	projectId: string;
	/** CSS class name */
	className?: string;
}

export interface LogEntry {
	id: string;
	timestamp: number;
	level: 'log' | 'info' | 'warn' | 'error' | 'debug';
	message: string;
	source?: 'server' | 'client' | 'system';
}

export interface LogCounts {
	errors: number;
	warnings: number;
	logs: number;
}
