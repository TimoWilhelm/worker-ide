import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useChangeReview } from './use-change-review';

import type { PendingFileChange } from '@shared/types';
import type { ReactNode } from 'react';

const okResponse = { ok: true, json: async () => ({ success: true }) };

vi.mock('@/lib/api-client', () => ({
	createApiClient: () => ({
		review: {
			':id': {
				resolve: { $post: vi.fn(async () => okResponse) },
				hunks: { $put: vi.fn(async () => okResponse) },
			},
			'resolve-many': { $post: vi.fn(async () => okResponse) },
		},
	}),
}));

function createPendingChange(path: string, sessionId: string): PendingFileChange {
	return {
		path,
		action: 'edit',
		beforeContent: 'before',
		afterContent: `after:${sessionId}`,
		snapshotId: `${sessionId}-snapshot`,
		status: 'pending',
		hunkStatuses: ['pending'],
		hunkSessionIds: [[sessionId]],
		sessionId,
		sessionIds: [sessionId],
		reviewId: `${path}:${sessionId}`,
	};
}

function wrapper({ children }: { children: ReactNode }) {
	const queryClient = new QueryClient();
	return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}

describe('useChangeReview', () => {
	beforeEach(() => {
		useStore.setState({
			pendingChanges: new Map([
				['/src/a.ts', createPendingChange('/src/a.ts', 'session-1')],
				['/src/b.ts', createPendingChange('/src/b.ts', 'session-2')],
			]),
		});
	});

	it('does not show the session summary when there is no active session', () => {
		const { result } = renderHook(() => useChangeReview({ projectId: 'project-1' }), { wrapper });

		expect(result.current.sessionPendingCount()).toBe(0);
		expect(result.current.pendingCount).toBe(2);
	});

	it('counts only changes for the selected session in the panel summary', () => {
		const { result } = renderHook(() => useChangeReview({ projectId: 'project-1' }), { wrapper });

		expect(result.current.sessionPendingCount('session-1')).toBe(1);
		expect(result.current.sessionPendingCount('session-2')).toBe(1);
	});

	it('approves optimistically in the store without writing the file-content cache', async () => {
		const queryClient = new QueryClient();
		const setQueryData = vi.spyOn(queryClient, 'setQueryData');
		function clientWrapper({ children }: { children: ReactNode }) {
			return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
		}

		const { result } = renderHook(() => useChangeReview({ projectId: 'project-1' }), { wrapper: clientWrapper });

		await act(async () => {
			result.current.handleApproveChange('/src/a.ts');
		});

		// Display is derived from store state, not an imperative cache write.
		expect(useStore.getState().pendingChanges.get('/src/a.ts')?.status).toBe('approved');
		expect(setQueryData).not.toHaveBeenCalled();
	});
});
