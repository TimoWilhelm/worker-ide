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

		const { rerender } = renderHook(() => useAiSessions({ projectId: 'project-1', agent }));

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

		const { rerender } = renderHook(() => useAiSessions({ projectId: 'project-1', agent }));

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
});
