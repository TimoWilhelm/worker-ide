/**
 * System Prompt Builder.
 *
 * Assembles the system prompts for the AI agent by combining the base
 * prompt with mode-specific addendums, project guidelines (AGENTS.md),
 * active plans, and IDE output logs.
 *
 * Pure-ish function that only reads from the filesystem and constants —
 * no service state dependency.
 */

import fs from 'node:fs/promises';

import {
	AGENT_SYSTEM_PROMPT,
	AGENTS_MD_MAX_CHARACTERS,
	ASK_MODE_SYSTEM_PROMPT,
	CODE_MODE_SYSTEM_PROMPT,
	PLAN_MODE_SYSTEM_PROMPT,
} from '@shared/constants';

import { readTodos } from './tool-executor';

/**
 * Build the complete system prompts array for the agent.
 *
 * @param projectRoot - Absolute path to the project root
 * @param mode - Current agent mode (code, plan, ask)
 * @param outputLogs - Optional IDE output logs to include
 * @param sessionId - Optional session ID for reading session-scoped todos
 */
export async function buildSystemPrompts(
	projectRoot: string,
	mode: 'code' | 'plan' | 'ask',
	outputLogs?: string,
	sessionId?: string,
): Promise<string[]> {
	const prompts: string[] = [];

	let mainPrompt = AGENT_SYSTEM_PROMPT;

	// Add AGENTS.md context
	const agentsContext = await readAgentsContext(projectRoot);
	if (agentsContext) {
		mainPrompt += `\n\n## Project Guidelines (from AGENTS.md)\n${agentsContext}`;
	}

	// Add mode-specific addendum
	switch (mode) {
		case 'code': {
			mainPrompt += CODE_MODE_SYSTEM_PROMPT;

			break;
		}
		case 'plan': {
			mainPrompt += PLAN_MODE_SYSTEM_PROMPT;

			break;
		}
		case 'ask': {
			mainPrompt += ASK_MODE_SYSTEM_PROMPT;

			break;
		}
		// No default
	}

	// Add latest plan context (in code mode only)
	if (mode !== 'plan') {
		const latestPlan = await readLatestPlan(projectRoot);
		if (latestPlan) {
			mainPrompt += `\n\n## Active Implementation Plan\nFollow this plan for all implementation steps. Reference it to decide what to do next and mark steps as complete when done.\n\n${latestPlan}`;
		}
	}

	// Inject current todo list for code and plan modes
	if (mode !== 'ask') {
		const todosContext = await readCurrentTodos(projectRoot, sessionId);
		if (todosContext) {
			mainPrompt += `\n\n## Active Todo List\nThis is your current task list. Use it to track progress and decide what to work on next.\n\n${todosContext}`;
		}
	}

	// Append IDE output logs (bundle errors, server logs, client console, lint)
	if (outputLogs && outputLogs.trim().length > 0) {
		mainPrompt += `\n\n## IDE Output Logs\nThe following are recent output messages from the IDE (bundle errors, server logs, client console logs, lint diagnostics). Use these to diagnose issues the user may be experiencing.\n\n<output_logs>\n${outputLogs}\n</output_logs>`;
	}

	prompts.push(mainPrompt);
	return prompts;
}

/**
 * Read the AGENTS.md file from the project root (case-insensitive).
 * Returns undefined if not found. Truncates at AGENTS_MD_MAX_CHARACTERS.
 */
async function readAgentsContext(projectRoot: string): Promise<string | undefined> {
	try {
		const entries = await fs.readdir(projectRoot);
		const agentsFile = entries.find((entry) => entry.toLowerCase() === 'agents.md');
		if (!agentsFile) return undefined;

		let content = await fs.readFile(`${projectRoot}/${agentsFile}`, 'utf8');
		if (content.length > AGENTS_MD_MAX_CHARACTERS) {
			content = content.slice(0, AGENTS_MD_MAX_CHARACTERS) + '\n...(truncated)';
		}
		return content;
	} catch {
		return undefined;
	}
}

/**
 * Read the current todo list for a session.
 * Returns a formatted string of todos, or undefined if none exist.
 */
async function readCurrentTodos(projectRoot: string, sessionId?: string): Promise<string | undefined> {
	try {
		const todos = await readTodos(projectRoot, sessionId);
		if (todos.length === 0) return undefined;

		const lines = todos.map((todo) => {
			const statusIcon = todo.status === 'completed' ? '[x]' : todo.status === 'in_progress' ? '[~]' : '[ ]';
			return `- ${statusIcon} (${todo.priority}) ${todo.content}`;
		});
		return lines.join('\n');
	} catch {
		return undefined;
	}
}

/**
 * Read the most recent plan file from .agent/plans/.
 * Returns undefined if no plans exist.
 */
async function readLatestPlan(projectRoot: string): Promise<string | undefined> {
	try {
		const plansDirectory = `${projectRoot}/.agent/plans`;
		const entries = await fs.readdir(plansDirectory);
		const planFiles = entries.filter((entry) => entry.endsWith('-plan.md')).toSorted();
		if (planFiles.length === 0) return undefined;

		const latestFile = planFiles.at(-1);
		if (!latestFile) return undefined;

		const content = await fs.readFile(`${plansDirectory}/${latestFile}`, 'utf8');
		if (!content.trim()) return undefined;

		return content;
	} catch {
		return undefined;
	}
}
