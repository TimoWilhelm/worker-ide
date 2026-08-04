import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_AI_MODEL } from '@shared/constants';

import {
	buildTerminalNotification,
	buildLoadedExtensionsSummary,
	getActiveThinkMessages,
	mergeThinkHistory,
	reattachForkedMessageState,
	restoreExtensionManager,
	runSessionSearch,
} from './agent-runner-helpers';

import type { ChatMessage } from '@shared/types';

describe('agent-runner helpers', () => {
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

	it('preserves rich user parts and request metadata when merging Think history', () => {
		const existing: ChatMessage = {
			id: 'submission-1',
			role: 'user',
			parts: [
				{ type: 'text', content: 'inspect this' },
				{ type: 'image', url: 'data:image/png;base64,abc', mediaType: 'image/png', name: 'screen.png' },
			],
			createdAt: 10,
			authorUserId: 'user-1',
			metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'queued' } },
		};
		const converted: ChatMessage = {
			id: existing.id,
			role: 'user',
			parts: [{ type: 'text', content: 'inspect this' }],
			createdAt: 20,
		};

		expect(mergeThinkHistory([converted], [existing])).toEqual([
			{ ...existing, metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'committed' } } },
		]);
	});

	it('retains queued and running submission messages with their current states', () => {
		const messages: ChatMessage[] = ['pending', 'running', 'completed'].map((id) => ({
			id,
			role: 'user',
			parts: [{ type: 'text', content: id }],
			createdAt: 1,
			metadata: { request: { mode: 'code', model: DEFAULT_AI_MODEL, state: 'queued' } },
		}));

		const active = getActiveThinkMessages(messages, [
			{ submissionId: 'pending', status: 'pending' },
			{ submissionId: 'running', status: 'running' },
		]);

		expect(active.map((message) => [message.id, message.metadata?.request?.state])).toEqual([
			['pending', 'queued'],
			['running', 'committed'],
		]);
	});

	it('suppresses terminal notifications while a queued follow-up starts', () => {
		expect(buildTerminalNotification('completed', undefined, true)).toBeUndefined();
		expect(buildTerminalNotification('error', 'Boom', true)).toBeUndefined();
	});

	it('builds terminal notifications once the agent is idle', () => {
		expect(buildTerminalNotification('completed', undefined, false)).toEqual({
			title: 'Generation complete',
			body: 'Your AI agent has finished.',
			urgency: 'normal',
		});
		expect(buildTerminalNotification('error', 'Boom', false)).toEqual({
			title: 'Generation failed',
			body: 'Boom',
			urgency: 'high',
		});
		expect(buildTerminalNotification('aborted', undefined, false)).toBeUndefined();
	});
});
