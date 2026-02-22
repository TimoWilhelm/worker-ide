/**
 * Tool: plan_update
 * Update the current implementation plan.
 */

import fs from 'node:fs/promises';

import type { SendEventFunction, ToolDefinition, ToolExecutorContext } from '../types';

export const DESCRIPTION = `Update the current implementation plan. Use this to mark steps as complete, add new steps, or revise the plan as you make progress. The plan helps the user understand your approach and track progress.

Usage:
- Provide the full updated plan content, not just the changes.
- Use markdown format for structure (headings, lists, checkboxes).
- Update the plan as you progress through implementation.
- Keep the plan concise and actionable — avoid unnecessary detail.`;

export const definition: ToolDefinition = {
	name: 'plan_update',
	description: DESCRIPTION,
	input_schema: {
		type: 'object',
		properties: {
			content: { type: 'string', description: 'The full updated plan content in markdown format' },
		},
		required: ['content'],
	},
};

export async function execute(
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
): Promise<string | object> {
	const { projectRoot, sessionId } = context;
	const content = input.content;

	await sendEvent('status', { message: 'Updating plan...' });

	try {
		const planDirectory = `${projectRoot}/.agent/plans`;
		await fs.mkdir(planDirectory, { recursive: true });
		const planFile = `${planDirectory}/${sessionId || 'default'}.md`;

		// Read previous plan to compute a meaningful diff
		let previousContent: string | undefined;
		try {
			previousContent = await fs.readFile(planFile, 'utf8');
		} catch {
			// No previous plan — this is a new plan
		}

		await fs.writeFile(planFile, content);
		await sendEvent('plan_updated', { content });

		const lineCount = content.split('\n').length;
		const completedCount = (content.match(/- \[x\]/gi) || []).length;
		const pendingCount = (content.match(/- \[ \]/g) || []).length;
		const totalTasks = completedCount + pendingCount;

		let result = `Plan updated (${lineCount} lines).`;
		if (totalTasks > 0) {
			result += ` Progress: ${completedCount}/${totalTasks} tasks completed.`;
		}
		if (previousContent === content) {
			result += ' (no changes from previous plan)';
		}

		return { result, path: planFile };
	} catch (error) {
		return { error: `Failed to update plan: ${String(error)}` };
	}
}
