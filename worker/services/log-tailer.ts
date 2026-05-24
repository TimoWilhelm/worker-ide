import { WorkerEntrypoint } from 'cloudflare:workers';

import { coordinatorNamespace } from '../lib/durable-object-namespaces';

import type { ServerLogEntry, SourceLocation } from '@shared/types';

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
					location: exception.stack ? parseStackLocation(exception.stack) : undefined,
				});
			}
		}

		if (logs.length === 0) return;

		try {
			const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
			await coordinatorStub.sendMessage({ type: 'server-logs', logs });
		} catch {
			// Best-effort — don't fail the tail if broadcast fails
		}
	}
}

function parseStackLocation(stack: string): SourceLocation | undefined {
	for (const stackLine of stack.split('\n')) {
		const match = stackLine.match(/at\s+.*?\(?([\w./-]+\.(?:js|ts|mjs|tsx|jsx)):(\d+):(\d+)\)?/);
		if (!match || !/^worker\//.test(match[1])) continue;
		return {
			file: match[1],
			line: Number(match[2]),
			column: Number(match[3]),
		};
	}
	return undefined;
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
