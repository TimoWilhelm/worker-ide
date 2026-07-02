import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import {
	buildTerminalNotification,
	buildLoadedExtensionsSummary,
	buildRecoveredRunParameters,
	parseFiberSnapshot,
	reattachForkedMessageState,
	resolveInitialPendingChanges,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';

import type { FiberSnapshot } from '@shared/agent-state';
import type { ChatMessage, PendingFileChange } from '@shared/types';

function createUserMessage(content: string): ChatMessage {
	return {
		id: crypto.randomUUID(),
		role: 'user',
		parts: [{ type: 'text', content }],
		createdAt: Date.now(),
	};
}

function createValidSnapshot(overrides?: Partial<FiberSnapshot>): FiberSnapshot {
	return {
		workingMessages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
		chatMessages: [createUserMessage('hello')],
		iteration: 2,
		queryChanges: [{ path: 'src/app.ts', action: 'edit', beforeContent: 'a', afterContent: 'b', isBinary: false }],
		pendingChanges: {
			'src/app.ts': {
				path: 'src/app.ts',
				action: 'edit',
				beforeContent: 'a',
				afterContent: 'b',
				snapshotId: 'snapshot-1',
				status: 'pending',
				hunkStatuses: ['pending'],
				sessionId: 'session-1',
			},
		},
		toolMetadata: {
			tool1: { toolCallId: 'tool1', toolName: 'lint_fix', title: 'Edited file', metadata: { path: 'src/app.ts' } },
		},
		toolErrors: {
			tool2: { toolCallId: 'tool2', toolName: 'lint_check', errorCode: 'not_found', errorMessage: 'missing' },
		},
		contextTokensUsed: 42,
		snapshotId: 'snapshot-1',
		model: DEFAULT_AI_MODEL,
		mode: 'ask',
		...overrides,
	};
}

describe('agent-runner helpers', () => {
	it('parses a valid fiber snapshot', () => {
		const snapshot = createValidSnapshot();

		expect(parseFiberSnapshot(snapshot)).toEqual(snapshot);
	});

	it('rejects an invalid fiber snapshot', () => {
		const snapshot = createValidSnapshot({ mode: 'invalid-mode' });
		const parsed = parseFiberSnapshot({ ...snapshot, pendingChanges: 'bad' });

		expect(parsed).toBeUndefined();
	});

	it('builds recovered run parameters with normalized fallback mode and model', () => {
		const history = [createUserMessage('Recover me')];
		const snapshot = createValidSnapshot({ mode: 'invalid-mode', model: 'invalid-model' });

		const recovered = buildRecoveredRunParameters('project-1', 'org-1', 'session-1', history, snapshot);

		expect(recovered).toMatchObject({
			projectId: 'project-1',
			organizationId: 'org-1',
			sessionId: 'session-1',
			messages: history,
			mode: 'code',
			model: DEFAULT_AI_MODEL,
			initiatorUserId: history[0]?.authorUserId,
			_fiberSnapshot: snapshot,
		});
	});

	it('prefers fiber snapshot pending changes and otherwise falls back to persisted session changes', () => {
		const fiberPendingChanges = createValidSnapshot().pendingChanges;
		const persistedPendingChanges: Record<string, PendingFileChange> = {
			'src/other.ts': {
				path: 'src/other.ts',
				action: 'edit',
				beforeContent: 'old',
				afterContent: 'new',
				snapshotId: undefined,
				status: 'pending',
				hunkStatuses: ['pending'],
				sessionId: 'session-1',
			},
		};

		expect(resolveInitialPendingChanges(createValidSnapshot(), persistedPendingChanges)).toEqual(fiberPendingChanges);
		expect(resolveInitialPendingChanges(undefined, persistedPendingChanges)).toEqual(persistedPendingChanges);
		expect(resolveInitialPendingChanges()).toEqual({});
	});

	it('skips session search for blank queries and trims non-empty queries', async () => {
		const search = vi.fn(async (trimmedQuery: string, limit: number) => [
			{ sessionId: 'session-1', role: 'user', content: `${trimmedQuery}:${limit}` },
		]);

		await expect(runSessionSearch('   ', 10, search)).resolves.toEqual([]);
		expect(search).not.toHaveBeenCalled();

		await expect(runSessionSearch('  auth bug  ', 5, search)).resolves.toEqual([
			{ sessionId: 'session-1', role: 'user', content: 'auth bug:5' },
		]);
		expect(search).toHaveBeenCalledWith('auth bug', 5);
	});

	it('restores extension manager instances and builds summaries', async () => {
		class FakeExtensionManager {
			static restoreCalls = 0;
			constructor(public readonly options: { loader: unknown; storage: unknown }) {}

			async restore(): Promise<void> {
				FakeExtensionManager.restoreCalls += 1;
			}

			list() {
				return [
					{ name: 'github', description: 'GitHub helpers', tools: ['search', 'create_issue'] },
					{ name: 'deploy', description: undefined, tools: ['deploy'] },
				];
			}
		}

		const loader = {};
		const storage = {};
		const manager = await restoreExtensionManager(loader, storage, FakeExtensionManager);

		expect(FakeExtensionManager.restoreCalls).toBe(1);
		expect(manager.options).toEqual({ loader, storage });
		expect(buildLoadedExtensionsSummary(manager)).toEqual([
			{ name: 'github', description: 'GitHub helpers', toolCount: 2 },
			{ name: 'deploy', description: undefined, toolCount: 1 },
		]);
	});

	it('reattaches forked message author and metadata by index, not by id', () => {
		// `fork` assigns fresh message IDs, so the forked history shares no IDs
		// with the source. Reattachment must align by position.
		const sourceHistory: ChatMessage[] = [
			{
				id: 'source-1',
				role: 'user',
				parts: [{ type: 'text', content: 'first' }],
				createdAt: 1,
				authorUserId: 'user-1',
				metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'committed' } },
			},
			{
				id: 'source-2',
				role: 'assistant',
				parts: [{ type: 'text', content: 'reply' }],
				createdAt: 2,
			},
			{
				id: 'source-3',
				role: 'user',
				parts: [{ type: 'text', content: 'second' }],
				createdAt: 3,
				authorUserId: 'user-2',
			},
		];
		const forkedHistory: ChatMessage[] = sourceHistory.map((message) => ({
			id: crypto.randomUUID(),
			role: message.role,
			parts: message.parts,
			createdAt: message.createdAt,
		}));

		const reattached = reattachForkedMessageState(forkedHistory, sourceHistory);

		expect(reattached.map((message) => message.authorUserId)).toEqual(['user-1', undefined, 'user-2']);
		expect(reattached[0]?.metadata).toEqual(sourceHistory[0]?.metadata);
		// Forked IDs are preserved, only author/metadata are reattached.
		expect(reattached.map((message) => message.id)).toEqual(forkedHistory.map((message) => message.id));
	});

	it('suppresses terminal notifications while a queued follow-up starts', () => {
		expect(buildTerminalNotification('completed', undefined, true)).toBeUndefined();
		expect(buildTerminalNotification('error', 'Boom', true)).toBeUndefined();
	});

	it('builds terminal notifications once the agent is idle', () => {
		expect(buildTerminalNotification('completed', undefined, false)).toEqual({
			title: 'Generation complete',
			body: 'Your AI agent has finished.',
		});
		expect(buildTerminalNotification('error', 'Boom', false)).toEqual({
			title: 'Generation failed',
			body: 'Boom',
		});
		expect(buildTerminalNotification('aborted', undefined, false)).toBeUndefined();
	});
});
