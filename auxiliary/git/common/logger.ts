export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const levelValue: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40,
};

function parseLevel(input?: string | null): LogLevel {
	const v = (input || '').toLowerCase();
	if (v === 'debug' || v === 'info' || v === 'warn' || v === 'error') return v;
	return 'info';
}

export interface LoggerContext {
	service: string;
	repoId?: string;
	doId?: string;
	requestId?: string;
}

export interface Logger {
	debug: (message: string, extra?: Record<string, unknown>) => void;
	info: (message: string, extra?: Record<string, unknown>) => void;
	warn: (message: string, extra?: Record<string, unknown>) => void;
	error: (message: string, extra?: Record<string, unknown>) => void;
}

function emit(level: LogLevel, context: LoggerContext, enabled: LogLevel, message: string, extra?: Record<string, unknown>) {
	if (levelValue[level] < levelValue[enabled]) return;
	const entry: Record<string, unknown> = {
		level,
		service: context.service,
	};
	if (context.repoId) entry.repoId = context.repoId;
	if (context.doId) entry.doId = context.doId;
	if (context.requestId) entry.requestId = context.requestId;
	entry.msg = message;
	if (extra) {
		for (const [k, v] of Object.entries(extra)) entry[k] = v;
	}
	const line = JSON.stringify(entry);
	switch (level) {
		case 'debug': {
			console.info(line);
			break;
		}
		case 'info': {
			console.info(line);
			break;
		}
		case 'warn': {
			console.info(line);
			break;
		}
		default: {
			console.error(line);
		}
	}
}

export function createLogger(level: string | undefined, base: LoggerContext): Logger {
	const enabled = parseLevel(level);
	return {
		debug: (message, extra) => emit('debug', base, enabled, message, extra),
		info: (message, extra) => emit('info', base, enabled, message, extra),
		warn: (message, extra) => emit('warn', base, enabled, message, extra),
		error: (message, extra) => emit('error', base, enabled, message, extra),
	};
}
