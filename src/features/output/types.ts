import type { SourceLocation } from '@shared/types';

export interface OutputPanelProperties {
	projectId: string;
	className?: string;
}

export interface LogEntry {
	id: string;
	timestamp: number;
	level: 'log' | 'info' | 'warning' | 'error' | 'debug';
	message: string;
	source?: 'server' | 'client' | 'system' | 'lint';
	location?: SourceLocation;
}

export interface LogCounts {
	errors: number;
	warnings: number;
	logs: number;
}
