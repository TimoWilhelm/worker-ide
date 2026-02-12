/**
 * Terminal Panel Component
 *
 * Displays server logs and console output.
 */

import { Circle, Trash2 } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { LogEntry, TerminalPanelProperties } from '../types';

// =============================================================================
// Component
// =============================================================================

/**
 * Terminal panel showing logs and console output.
 */
export function TerminalPanel({ projectId, className }: TerminalPanelProperties) {
	const [logs, setLogs] = useState<LogEntry[]>(() => [
		{
			id: '1',
			timestamp: Date.now(),
			level: 'info',
			message: `Terminal connected for project ${projectId.slice(0, 8)}...`,
			source: 'system',
		},
	]);
	const [filter, setFilter] = useState<'all' | 'server' | 'client'>('all');
	const scrollReference = useRef<HTMLDivElement>(null);
	const autoScrollReference = useRef(true);

	// Auto-scroll to bottom when new logs arrive
	useEffect(() => {
		if (autoScrollReference.current && scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [logs]);

	// Clear logs
	const handleClear = useCallback(() => {
		setLogs([]);
	}, []);

	// Filter logs
	const filteredLogs = logs.filter((log) => {
		if (filter === 'all') return true;
		return log.source === filter;
	});

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Toolbar */}
			<div
				className={`
					flex h-8 shrink-0 items-center justify-between border-b border-border px-2
				`}
			>
				<div className="flex items-center gap-2">
					<span className="text-xs font-medium text-text-secondary">Terminal</span>
					<div className="flex items-center gap-1">
						<FilterButton active={filter === 'all'} onClick={() => setFilter('all')}>
							All
						</FilterButton>
						<FilterButton active={filter === 'server'} onClick={() => setFilter('server')}>
							Server
						</FilterButton>
						<FilterButton active={filter === 'client'} onClick={() => setFilter('client')}>
							Client
						</FilterButton>
					</div>
				</div>
				<div className="flex items-center gap-1">
					<Tooltip content="Clear logs">
						<Button variant="ghost" size="icon" className="size-6" onClick={handleClear}>
							<Trash2 className="size-3" />
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Log output */}
			<ScrollArea.Root className="flex-1 overflow-hidden">
				<ScrollArea.Viewport ref={scrollReference} className="size-full">
					<div className="p-2 font-mono text-xs">
						{filteredLogs.length === 0 ? (
							<div className="flex items-center justify-center py-4 text-text-secondary">No logs yet</div>
						) : (
							filteredLogs.map((log) => <LogLine key={log.id} log={log} />)
						)}
					</div>
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>
		</div>
	);
}

// =============================================================================
// Sub-components
// =============================================================================

function FilterButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
	return (
		<button
			onClick={onClick}
			className={cn(
				'rounded-sm px-1.5 py-0.5 text-xs transition-colors',
				active ? 'bg-bg-tertiary text-text-primary' : 'text-text-secondary hover:text-text-primary',
			)}
		>
			{children}
		</button>
	);
}

const LEVEL_COLORS: Record<LogEntry['level'], string> = {
	log: 'text-text-secondary',
	info: 'text-blue-400',
	warn: 'text-yellow-400',
	error: 'text-red-400',
	debug: 'text-gray-500',
};

function LogLine({ log }: { log: LogEntry }) {
	const time = new Date(log.timestamp).toLocaleTimeString('en-US', {
		hour12: false,
		hour: '2-digit',
		minute: '2-digit',
		second: '2-digit',
	});

	return (
		<div
			className={`
				flex items-start gap-2 py-0.5
				hover:bg-bg-tertiary/50
			`}
		>
			<span className="shrink-0 text-text-secondary">{time}</span>
			<Circle className={cn('mt-1 size-2 shrink-0', LEVEL_COLORS[log.level])} fill="currentColor" />
			<span className="break-all text-text-primary">{log.message}</span>
		</div>
	);
}
