export interface AgentCallOptions {
	timeoutMs?: number;
	retryCount?: number;
	retryDelayMs?: number;
}

type AgentCallFunction = <T = unknown>(method: string, arguments_?: unknown[]) => Promise<T>;

const DEFAULT_AGENT_CALL_OPTIONS = {
	timeoutMs: 15_000,
	retryCount: 1,
	retryDelayMs: 400,
} satisfies Required<AgentCallOptions>;

const METHOD_CALL_OPTIONS: Record<string, AgentCallOptions> = {
	abortRun: { timeoutMs: 10_000, retryCount: 1, retryDelayMs: 250 },
	clearCurrentSession: { timeoutMs: 10_000, retryCount: 1, retryDelayMs: 250 },
	deleteSession: { timeoutMs: 20_000, retryCount: 1, retryDelayMs: 500 },
	loadSession: { timeoutMs: 12_000, retryCount: 1, retryDelayMs: 300 },
	removeQueuedMessage: { timeoutMs: 10_000, retryCount: 1, retryDelayMs: 250 },
	renameSession: { timeoutMs: 10_000, retryCount: 1, retryDelayMs: 250 },
	revertSession: { timeoutMs: 20_000, retryCount: 1, retryDelayMs: 500 },
	searchSessions: { timeoutMs: 8000, retryCount: 1, retryDelayMs: 250 },
	startRun: { timeoutMs: 20_000, retryCount: 1, retryDelayMs: 750 },
	submitMessage: { timeoutMs: 20_000, retryCount: 1, retryDelayMs: 750 },
};

export class AgentCallTimeoutError extends Error {
	constructor(
		readonly method: string,
		readonly timeoutMs: number,
	) {
		super(`Agent call "${method}" timed out after ${timeoutMs}ms`);
		this.name = 'AgentCallTimeoutError';
	}
}

function resolveAgentCallOptions(method: string, options?: AgentCallOptions): Required<AgentCallOptions> {
	return {
		timeoutMs: options?.timeoutMs ?? METHOD_CALL_OPTIONS[method]?.timeoutMs ?? DEFAULT_AGENT_CALL_OPTIONS.timeoutMs,
		retryCount: options?.retryCount ?? METHOD_CALL_OPTIONS[method]?.retryCount ?? DEFAULT_AGENT_CALL_OPTIONS.retryCount,
		retryDelayMs: options?.retryDelayMs ?? METHOD_CALL_OPTIONS[method]?.retryDelayMs ?? DEFAULT_AGENT_CALL_OPTIONS.retryDelayMs,
	};
}

function isRetryableAgentError(error: unknown): boolean {
	if (error instanceof AgentCallTimeoutError) {
		return true;
	}

	if (!(error instanceof Error)) {
		return false;
	}

	if (error.name === 'AbortError' || error instanceof TypeError) {
		return true;
	}

	const message = error.message.toLowerCase();
	return ['closed', 'connection', 'disconnect', 'fetch', 'network', 'reconnect', 'socket', 'timed out', 'timeout', 'transport'].some(
		(token) => message.includes(token),
	);
}

async function sleep(delayMs: number): Promise<void> {
	await new Promise((resolve) => {
		globalThis.setTimeout(resolve, delayMs);
	});
}

async function callWithTimeout<T>(
	callFunction: AgentCallFunction,
	method: string,
	arguments_: unknown[] | undefined,
	timeoutMs: number,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;

	try {
		return await Promise.race([
			callFunction<T>(method, arguments_),
			new Promise<T>((_, reject) => {
				timeoutId = globalThis.setTimeout(() => {
					reject(new AgentCallTimeoutError(method, timeoutMs));
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeoutId !== undefined) {
			globalThis.clearTimeout(timeoutId);
		}
	}
}

export function createAgentCaller(callFunction: AgentCallFunction) {
	return async function callAgent<T = unknown>(method: string, arguments_?: unknown[], options?: AgentCallOptions): Promise<T> {
		const resolvedOptions = resolveAgentCallOptions(method, options);

		for (let attempt = 0; ; attempt++) {
			try {
				return await callWithTimeout<T>(callFunction, method, arguments_, resolvedOptions.timeoutMs);
			} catch (error) {
				const shouldRetry = attempt < resolvedOptions.retryCount && isRetryableAgentError(error);
				if (!shouldRetry) {
					throw error;
				}

				await sleep(resolvedOptions.retryDelayMs * (attempt + 1));
			}
		}
	};
}
