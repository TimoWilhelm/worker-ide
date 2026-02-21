/**
 * Log Tailer
 *
 * A WorkerEntrypoint that receives tail events from dynamically-loaded
 * user workers (via the WorkerLoader `tails` option). It extracts console
 * log entries from TraceItems and broadcasts them to the IDE frontend
 * over the project WebSocket.
 */

import { WorkerEntrypoint } from 'cloudflare:workers';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';

import type { ServerLogEntry } from '@shared/types';

interface LogTailerProperties {
	projectId: string;
}

/**
 * Receives tail events from the user's sandboxed worker and forwards
 * console log entries to the IDE terminal via the project WebSocket.
 */
export class LogTailer extends WorkerEntrypoint<Env, LogTailerProperties> {
	async tail(events: TraceItem[]): Promise<void> {
		const { projectId } = this.ctx.props;

		const logs: ServerLogEntry[] = [];

		for (const event of events) {
			for (const log of event.logs) {
				const message = Array.isArray(log.message)
					? log.message.map((argument) => (typeof argument === 'string' ? argument : JSON.stringify(argument))).join(' ')
					: String(log.message);

				logs.push({
					type: 'server-log',
					timestamp: log.timestamp,
					level: mapLogLevel(log.level),
					message,
				});
			}

			for (const exception of event.exceptions) {
				logs.push({
					type: 'server-log',
					timestamp: exception.timestamp,
					level: 'error',
					message: exception.message + (exception.stack ? `\n${exception.stack}` : ''),
				});
			}
		}

		if (logs.length === 0) return;

		try {
			const coordinatorId = coordinatorNamespace.idFromName(`project:${projectId}`);
			const coordinatorStub = coordinatorNamespace.get(coordinatorId);
			await coordinatorStub.sendMessage({ type: 'server-logs', logs });
		} catch {
			// Best-effort — don't fail the tail if broadcast fails
		}
	}
}

function mapLogLevel(level: string): 'log' | 'warning' | 'error' | 'debug' | 'info' {
	switch (level) {
		case 'warn': {
			return 'warning';
		}
		case 'log':
		case 'warning':
		case 'error':
		case 'debug':
		case 'info': {
			return level;
		}
		default: {
			return 'log';
		}
	}
}
