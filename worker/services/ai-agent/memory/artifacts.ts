import type { TodoItem } from '../types';

const DEFAULT_SESSION_ID = 'default';
const PLAN_ARTIFACT_MAX_CHARACTERS = 12_000;
const TODO_ARTIFACT_MAX_CHARACTERS = 8000;
const DIAGNOSTICS_ARTIFACT_MAX_CHARACTERS = 12_000;
const SUB_AGENT_ARTIFACT_MAX_CHARACTERS = 16_000;

export const ROOT_MEMORY_CONTEXT_LABEL = 'memory';
export const ARTIFACTS_CONTEXT_LABEL = 'artifacts';
export const HISTORY_CONTEXT_LABEL = 'history';

export interface SearchableArtifactEntry {
	key: string;
	content: string;
}

interface ArtifactDocumentOptions {
	kind: 'plan' | 'todos' | 'diagnostics' | 'sub-agent';
	sessionId?: string;
	title: string;
	summary: string;
	body: string;
	maxCharacters: number;
	extra?: Record<string, string | number | undefined>;
}

function getArtifactSessionId(sessionId?: string): string {
	return sessionId?.trim() || DEFAULT_SESSION_ID;
}

export function buildPlanArtifactEntry(sessionId: string | undefined, content: string): SearchableArtifactEntry {
	const resolvedSessionId = getArtifactSessionId(sessionId);
	const lineCount = content.split('\n').length;
	const completedCount = (content.match(/- \[x\]/gi) || []).length;
	const pendingCount = (content.match(/- \[ \]/g) || []).length;

	return {
		key: `plan:${resolvedSessionId}`,
		content: buildArtifactDocument({
			kind: 'plan',
			sessionId: resolvedSessionId,
			title: 'Current implementation plan',
			summary: `Implementation plan with ${lineCount} lines and ${completedCount}/${completedCount + pendingCount} checklist items completed.`,
			body: content,
			maxCharacters: PLAN_ARTIFACT_MAX_CHARACTERS,
			extra: {
				lineCount,
				completedCount,
				pendingCount,
			},
		}),
	};
}

export function buildTodosArtifactEntry(sessionId: string | undefined, todos: TodoItem[]): SearchableArtifactEntry {
	const resolvedSessionId = getArtifactSessionId(sessionId);
	const completedCount = todos.filter((todo) => todo.status === 'completed').length;
	const inProgressCount = todos.filter((todo) => todo.status === 'in_progress').length;
	const pendingCount = todos.filter((todo) => todo.status === 'pending').length;
	const body = todos
		.map(
			(todo) => `- [${todo.status === 'completed' ? 'x' : todo.status === 'in_progress' ? '~' : ' '}] (${todo.priority}) ${todo.content}`,
		)
		.join('\n');

	return {
		key: `todos:${resolvedSessionId}`,
		content: buildArtifactDocument({
			kind: 'todos',
			sessionId: resolvedSessionId,
			title: 'Current todo list',
			summary: `${todos.length} todos with ${completedCount} completed, ${inProgressCount} in progress, and ${pendingCount} pending.`,
			body,
			maxCharacters: TODO_ARTIFACT_MAX_CHARACTERS,
			extra: {
				count: todos.length,
				completedCount,
				inProgressCount,
				pendingCount,
			},
		}),
	};
}

export function buildDiagnosticsArtifactEntry(
	sessionId: string | undefined,
	diagnostics: string,
	source: 'initial' | 'post-change',
): SearchableArtifactEntry {
	const resolvedSessionId = getArtifactSessionId(sessionId);

	return {
		key: `diagnostics:${resolvedSessionId}:${source}`,
		content: buildArtifactDocument({
			kind: 'diagnostics',
			sessionId: resolvedSessionId,
			title: source === 'initial' ? 'Recent IDE diagnostics at run start' : 'IDE diagnostics after file changes',
			summary: 'Recent IDE output logs, including build failures, runtime errors, warnings, and diagnostics.',
			body: diagnostics,
			maxCharacters: DIAGNOSTICS_ARTIFACT_MAX_CHARACTERS,
			extra: { source },
		}),
	};
}

export function buildSubAgentArtifactEntry(options: {
	sessionId?: string;
	toolCallId?: string;
	prompt: string;
	additionalContext?: string;
	resultText: string;
	iterations: number;
}): SearchableArtifactEntry {
	const resolvedSessionId = getArtifactSessionId(options.sessionId);
	const normalizedPrompt = options.prompt.trim();
	const normalizedContext = options.additionalContext?.trim();
	const body = [
		'## Delegated Task',
		normalizedPrompt,
		normalizedContext ? `\n## Additional Context\n${normalizedContext}` : undefined,
		'\n## Result',
		options.resultText.trim(),
	]
		.filter(Boolean)
		.join('\n');

	return {
		key: `sub-agent:${resolvedSessionId}:${options.toolCallId ?? crypto.randomUUID()}`,
		content: buildArtifactDocument({
			kind: 'sub-agent',
			sessionId: resolvedSessionId,
			title: 'Sub-agent report',
			summary: `Focused delegated run completed in ${options.iterations} turn${options.iterations === 1 ? '' : 's'}.`,
			body,
			maxCharacters: SUB_AGENT_ARTIFACT_MAX_CHARACTERS,
			extra: {
				iterations: options.iterations,
				toolCallId: options.toolCallId,
			},
		}),
	};
}

function buildArtifactDocument(options: ArtifactDocumentOptions): string {
	const lines = [
		`type: ${options.kind}`,
		`session: ${getArtifactSessionId(options.sessionId)}`,
		`updated-at: ${new Date().toISOString()}`,
		...Object.entries(options.extra ?? {})
			.filter(([, value]) => value !== undefined)
			.map(([key, value]) => `${key}: ${String(value)}`),
		'',
		`# ${options.title}`,
		'',
		options.summary.trim(),
		'',
		truncateForArtifact(options.body.trim(), options.maxCharacters, options.kind === 'diagnostics' ? 'start' : 'end'),
	];

	return lines.join('\n');
}

function truncateForArtifact(content: string, maxCharacters: number, strategy: 'start' | 'end'): string {
	if (content.length <= maxCharacters) {
		return content;
	}

	if (strategy === 'start') {
		return `... (older content truncated)\n${content.slice(-maxCharacters)}`;
	}

	return `${content.slice(0, maxCharacters)}\n... (truncated)`;
}
