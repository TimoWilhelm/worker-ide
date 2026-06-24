import { Bash } from 'just-bash';

import { JustBashFs } from './just-bash-fs';

import type { FileSystem as ShellFileSystem } from '@cloudflare/shell';

/** Default working directory: the project root is mounted here. */
export const BASH_CWD = '/project';

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_CHARS = 60_000;

export interface RunBashOptions {
	/** Working directory for the script. Defaults to {@link BASH_CWD}. */
	cwd?: string;
	/** Wall-clock timeout in milliseconds. Defaults to 30s. */
	timeoutMs?: number;
	/** Parent abort signal — aborting it cancels the running script. */
	abortSignal?: AbortSignal;
}

export interface RunBashResult {
	stdout: string;
	stderr: string;
	exitCode: number;
	/** Whether execution was cut short by the timeout/abort. */
	timedOut: boolean;
}

/**
 * Run a bash command line in an isolated {@link Bash} interpreter whose virtual
 * filesystem is backed by the given {@link ShellFileSystem}.
 *
 * The shell is sandboxed: no network, no Python, no JS execution — just the
 * built-in text/file tooling (`cat`, `grep`, `sed`, `awk`, `jq`, `find`, …)
 * operating on workspace files. File mutations flow straight through to the
 * backing filesystem (and, in production, on to the durable `Workspace`).
 */
export async function runBashCommand(
	commandLine: string,
	fileSystem: ShellFileSystem,
	options: RunBashOptions = {},
): Promise<RunBashResult> {
	const { cwd = BASH_CWD, timeoutMs = DEFAULT_TIMEOUT_MS, abortSignal } = options;

	if (abortSignal?.aborted) {
		return { stdout: '', stderr: 'Command aborted', exitCode: 124, timedOut: true };
	}

	const bash = new Bash({
		fs: new JustBashFs(fileSystem),
		cwd,
		// Network, Python, and js-exec stay disabled (the defaults) — the shell
		// is limited to deterministic text/file tooling over the workspace.
		defenseInDepth: true,
	});

	const controller = new AbortController();
	const onParentAbort = (): void => controller.abort();
	abortSignal?.addEventListener('abort', onParentAbort, { once: true });
	const timer = setTimeout(() => controller.abort(), timeoutMs);

	try {
		const result = await bash.exec(commandLine, { cwd, signal: controller.signal });
		return {
			stdout: truncate(result.stdout),
			stderr: truncate(result.stderr),
			exitCode: result.exitCode,
			timedOut: false,
		};
	} catch (error) {
		if (controller.signal.aborted) {
			return { stdout: '', stderr: `Command aborted after ${timeoutMs}ms`, exitCode: 124, timedOut: true };
		}
		throw error;
	} finally {
		clearTimeout(timer);
		abortSignal?.removeEventListener('abort', onParentAbort);
	}
}

/** Build the LLM-facing text output for a completed bash run. */
export function formatBashOutput(result: RunBashResult): string {
	const sections: string[] = [];
	if (result.stdout) sections.push(result.stdout.trimEnd());
	if (result.stderr) sections.push(`stderr:\n${result.stderr.trimEnd()}`);
	if (result.exitCode !== 0) sections.push(`Exited with code ${result.exitCode}`);
	return sections.join('\n\n') || `Exited with code ${result.exitCode}`;
}

function truncate(text: string): string {
	if (text.length <= MAX_OUTPUT_CHARS) return text;
	return `${text.slice(0, MAX_OUTPUT_CHARS)}\n…[truncated ${text.length - MAX_OUTPUT_CHARS} chars]`;
}
