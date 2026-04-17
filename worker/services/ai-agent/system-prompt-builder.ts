import fs from 'node:fs/promises';

import { stripIndent } from 'common-tags';

import { AGENTS_MD_MAX_CHARACTERS, ASK_MODE_SYSTEM_PROMPT, CODE_MODE_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from '@shared/constants';

import { readTodos } from './tool-executor';

const MAX_PLAN_CHARACTERS = 8000;
const MAX_TODOS_CHARACTERS = 4000;
const MAX_OUTPUT_LOG_CHARACTERS = 8000;

export async function buildRuntimePromptAdditions(
	projectRoot: string,
	mode: 'code' | 'plan' | 'ask',
	outputLogs?: string,
	sessionId?: string,
): Promise<string> {
	let addendum = '';

	switch (mode) {
		case 'code': {
			addendum += CODE_MODE_SYSTEM_PROMPT;
			break;
		}
		case 'plan': {
			addendum += PLAN_MODE_SYSTEM_PROMPT;
			break;
		}
		case 'ask': {
			addendum += ASK_MODE_SYSTEM_PROMPT;
			break;
		}
	}

	if (mode !== 'plan') {
		const latestPlan = await readLatestPlan(projectRoot);
		if (latestPlan) {
			addendum += `\n\n${stripIndent`
				## Active Implementation Plan
				Follow this plan for all implementation steps. Reference it to decide what to do next and mark steps as complete when done.

				${truncateFromEnd(latestPlan, MAX_PLAN_CHARACTERS)}
			`}`;
		}
	}

	if (mode !== 'ask') {
		const todosContext = await readCurrentTodos(projectRoot, sessionId);
		if (todosContext) {
			addendum += `\n\n${stripIndent`
				## Active Todo List
				This is your current task list. Use it to track progress and decide what to work on next.

				${truncateFromEnd(todosContext, MAX_TODOS_CHARACTERS)}
			`}`;
		}
	}

	if (outputLogs && outputLogs.trim().length > 0) {
		addendum += `\n\n${stripIndent`
			## IDE Output Logs
			The following are recent output messages from the IDE (bundle errors, server logs, client console logs, lint diagnostics). Use these to diagnose issues the user may be experiencing.

			<output_logs>
			${truncateFromStart(outputLogs, MAX_OUTPUT_LOG_CHARACTERS)}
			</output_logs>
		`}`;
	}

	return addendum;
}

export async function readAgentsContext(projectRoot: string): Promise<string | undefined> {
	try {
		const entries = await fs.readdir(projectRoot);
		const agentsFile = entries.find((entry) => entry.toLowerCase() === 'agents.md');
		if (!agentsFile) {
			return undefined;
		}

		let content = await fs.readFile(`${projectRoot}/${agentsFile}`, 'utf8');
		if (content.length > AGENTS_MD_MAX_CHARACTERS) {
			content = content.slice(0, AGENTS_MD_MAX_CHARACTERS) + '\n... (truncated)';
		}
		return content;
	} catch {
		return undefined;
	}
}

function truncateFromEnd(content: string, maxLength: number): string {
	if (content.length <= maxLength) return content;
	return content.slice(0, maxLength) + '\n... (truncated)';
}

function truncateFromStart(content: string, maxLength: number): string {
	if (content.length <= maxLength) return content;
	return '... (older entries truncated)\n' + content.slice(-maxLength);
}

async function readCurrentTodos(projectRoot: string, sessionId?: string): Promise<string | undefined> {
	try {
		const todos = await readTodos(projectRoot, sessionId);
		if (todos.length === 0) return undefined;

		return todos
			.map((todo) => {
				const statusIcon = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
				return `- ${statusIcon} (${todo.priority}) ${todo.content}`;
			})
			.join('\n');
	} catch {
		return undefined;
	}
}

async function readLatestPlan(projectRoot: string): Promise<string | undefined> {
	try {
		const plansDirectory = `${projectRoot}/.agent/plans`;
		const entries = await fs.readdir(plansDirectory);
		const planFiles = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();
		const latestFile = planFiles.at(-1);
		if (!latestFile) {
			return undefined;
		}

		const content = await fs.readFile(`${plansDirectory}/${latestFile}`, 'utf8');
		return content.trim() ? content : undefined;
	} catch {
		return undefined;
	}
}
