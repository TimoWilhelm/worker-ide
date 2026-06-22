import { AGENTS_MD_MAX_CHARACTERS, ASK_MODE_SYSTEM_PROMPT, CODE_MODE_SYSTEM_PROMPT, PLAN_MODE_SYSTEM_PROMPT } from '@shared/constants';
import { fs } from '@worker/lib/project-fs';

export async function buildRuntimePromptAdditions(
	_projectRoot: string,
	mode: 'code' | 'plan' | 'ask',
	_outputLogs?: string,
	_sessionId?: string,
): Promise<string> {
	switch (mode) {
		case 'code': {
			return CODE_MODE_SYSTEM_PROMPT;
		}
		case 'plan': {
			return PLAN_MODE_SYSTEM_PROMPT;
		}
		case 'ask': {
			return ASK_MODE_SYSTEM_PROMPT;
		}
	}

	return '';
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
