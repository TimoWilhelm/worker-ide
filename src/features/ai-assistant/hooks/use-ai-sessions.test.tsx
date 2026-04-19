import { renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useAiSessions } from './use-ai-sessions';

import type { AgentState, AgentSessionState } from '@shared/agent-state';
import type { PendingFileChange, ReviewEntry } from '@shared/types';

function createPendingChange(path: string, sessionId: string, reviewId?: string): PendingFileChange {
	return {
		path,
		action: 'create',
		beforeContent: undefined,
		afterContent: `content:${path}:${sessionId}`,
		snapshotId: `${sessionId}-snapshot`,
		status: 'pending',
		hunkStatuses: ['pending'],
		sessionId,
		sessionIds: [sessionId],
		reviewId,
	};
}

function createReviewEntry(path: string, sessionId: string, sessionIds = [sessionId]): ReviewEntry {
	return {
		id: `${path}:${sessionId}`,
		path,
		action: 'create',
		beforeContent: undefined,
		afterContent: `content:${path}:${sessionId}`,
		snapshotId: `${sessionId}-snapshot`,
		status: 'pending',
		hunkStatuses: ['pending'],
		latestSessionId: sessionId,
		sessionIds,
		diffSignature: `${path}:${sessionId}`,
		updatedAt: sessionIds.length,
	};
}

function createCurrentSession(sessionId: string, status: AgentSessionState['status'] = 'idle'): AgentSessionState {
	return {
		sessionId,
		title: `Session ${sessionId}`,
		status,
		messages: [],
		statusText: undefined,
		error: undefined,
		contextTokensUsed: 0,
		pendingChanges: {},
		toolMetadata: {},
		toolErrors: {},
		debugLogId: undefined,
		stopRequested: false,
		pendingQuestion: undefined,
		needsContinuation: false,
		doomLoopMessage: undefined,
		subAgentActivities: {},
	};
}

beforeEach(() => {
	useStore.setState({ pendingChanges: new Map() });
	localStorage.clear();
});

describe('useAiSessions', () => {
	it('syncs review queue changes when agent state mutates in place', async () => {
		const state: AgentState = {
			currentSession: createCurrentSession('session-1'),
			sessions: [
				{ id: 'session-1', title: 'Session 1', createdAt: 1, isRunning: false },
				{ id: 'session-2', title: 'Session 2', createdAt: 2, isRunning: false },
			],
			reviewEntries: {
				'/src/a.ts': createReviewEntry('/src/a.ts', 'session-1'),
			},
			reviewSummary: {
				unresolvedCount: 1,
				reviewVersion: 1,
				sessionCounts: { 'session-1': 1 },
			},
		};
		const agent = {
			get state() {
				return state;
			},
			call: vi.fn().mockImplementation(async () => {}),
		};

		const { rerender } = renderHook(() => useAiSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.has('/src/a.ts')).toBe(true);
		});

		state.reviewEntries['/src/b.ts'] = createReviewEntry('/src/b.ts', 'session-2');
		state.reviewSummary.reviewVersion = 2;
		state.reviewSummary.unresolvedCount = 2;
		state.reviewSummary.sessionCounts['session-2'] = 1;

		rerender();

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.has('/src/b.ts')).toBe(true);
		});
	});

	it('syncs live pending changes when a running session mutates them in place', async () => {
		const currentSession = createCurrentSession('session-2', 'running');
		const state: AgentState = {
			currentSession,
			sessions: [{ id: 'session-2', title: 'Session 2', createdAt: 2, isRunning: true }],
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const agent = {
			get state() {
				return state;
			},
			call: vi.fn().mockImplementation(async () => {}),
		};

		const { rerender } = renderHook(() => useAiSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(useStore.getState().pendingChanges.size).toBe(0);
		});

		currentSession.pendingChanges['/src/live.ts'] = createPendingChange('/src/live.ts', 'session-2');

		rerender();

		await waitFor(() => {
			const liveChange = useStore.getState().pendingChanges.get('/src/live.ts');
			expect(liveChange?.sessionId).toBe('session-2');
		});
	});

	it('does not show a restore spinner when there is no saved session to restore', () => {
		const agent = {
			get state() {
				return;
			},
			call: vi.fn().mockImplementation(async () => {}),
		};

		const { result } = renderHook(() => useAiSessions({ projectId: 'project-1', agent, agentConnectionState: 'connecting' }));

		expect(result.current.isRestoringSession).toBe(false);
		expect(agent.call).not.toHaveBeenCalled();
	});

	it('clears stale saved sessions that cannot be restored', async () => {
		localStorage.setItem('worker-ide-active-session:project-1', 'missing-session');

		const state: AgentState = {
			currentSession: undefined,
			sessions: [],
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const agent = {
			get state() {
				return state;
			},
			call: vi.fn().mockResolvedValue(),
		};

		const { result } = renderHook(() => useAiSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(agent.call).toHaveBeenCalledWith('loadSession', ['missing-session']);
			expect(result.current.isRestoringSession).toBe(false);
		});

		expect(localStorage.getItem('worker-ide-active-session:project-1')).toBeNull();
	});

	it('syncs a restored current session back into persisted session storage', async () => {
		localStorage.setItem('worker-ide-active-session:project-1', 'outdated-session');

		const state: AgentState = {
			currentSession: createCurrentSession('session-3'),
			sessions: [{ id: 'session-3', title: 'Session 3', createdAt: 3, isRunning: false }],
			reviewEntries: {},
			reviewSummary: {
				unresolvedCount: 0,
				reviewVersion: 1,
				sessionCounts: {},
			},
		};
		const agent = {
			get state() {
				return state;
			},
			call: vi.fn().mockResolvedValue(),
		};

		renderHook(() => useAiSessions({ projectId: 'project-1', agent, agentConnectionState: 'connected' }));

		await waitFor(() => {
			expect(localStorage.getItem('worker-ide-active-session:project-1')).toBe('session-3');
		});

		expect(agent.call).not.toHaveBeenCalledWith('loadSession', expect.anything());
	});
});
