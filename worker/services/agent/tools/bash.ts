import { WorkspaceFileSystem } from '@cloudflare/shell';

import { ToolErrorCode, toolError } from '@shared/tool-errors';
import { PROJECT_ROOT, WorkspaceClient } from '@worker/lib/workspace-client';

import { BASH_CWD, formatBashOutput, runBashCommand } from './bash/run-bash';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext, ToolResult } from '../types';

const DESCRIPTION = `Run a sandboxed Bash script against the project's files (mounted at ${BASH_CWD}).

Use this for shell-style workflows that combine multiple file operations or text processing in one step — pipelines with cat, grep, sed, awk, jq, sort, uniq, wc, cut, find, ls, tr, head, tail, diff, and friends. For a single read/write/edit, prefer the dedicated state.* operations.

Environment:
- The project root is the working directory (${BASH_CWD}); paths are resolved relative to it.
- Created, updated, and deleted files persist back to the workspace.
- Network access, Python, and arbitrary JS execution are DISABLED. Only built-in commands are available; there are no external binaries (no node, npm, git, python).
- Each invocation runs in a fresh shell (env/cwd reset); only filesystem changes persist between calls.`;

export const definition: ToolDefinition = {
	name: 'bash',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			command: {
				type: 'string',
				description: 'The bash command line to run, e.g. `grep -rn "TODO" src | wc -l`.',
			},
		},
		required: ['command'],
	},
};

export async function execute(
	input: Record<string, string>,
	_sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<ToolResult> {
	const command = input.command?.trim();
	if (!command) {
		return toolError(ToolErrorCode.MISSING_INPUT, 'A non-empty command is required.');
	}

	const fileSystem = new WorkspaceFileSystem(new WorkspaceClient(context.fsStub, PROJECT_ROOT, context.sessionId));
	const result = await runBashCommand(command, fileSystem, { abortSignal: context.abortSignal });

	return {
		title: command.length > 60 ? `${command.slice(0, 60)}…` : command,
		metadata: { exitCode: result.exitCode, timedOut: result.timedOut },
		output: formatBashOutput(result),
	};
}
