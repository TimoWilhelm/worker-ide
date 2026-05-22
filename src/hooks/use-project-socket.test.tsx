import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useProjectSocket } from './use-project-socket';

import type { ReactNode } from 'react';

class FakeWebSocket extends EventTarget {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.CONNECTING;

	constructor(readonly url: string) {
		super();
		FakeWebSocket.instances.push(this);
	}

	send(message: string): void {
		this.sentMessages.push(message);
	}

	close(code = 1000, reason = ''): void {
		this.readyState = FakeWebSocket.CLOSED;
		this.dispatchEvent(new CloseEvent('close', { code, reason }));
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.dispatchEvent(new Event('open'));
	}

	message(data: string): void {
		this.dispatchEvent(new MessageEvent('message', { data }));
	}
}

function createWrapper(queryClient: QueryClient) {
	return function Wrapper({ children }: { children: ReactNode }) {
		return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
	};
}

describe('useProjectSocket', () => {
	beforeEach(() => {
		FakeWebSocket.instances = [];
		vi.stubGlobal('WebSocket', FakeWebSocket);
		useStore.setState({
			participants: [],
			pendingChanges: new Map(),
			gitDiffView: undefined,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('applies incoming file edits to the file cache and participant cursor', async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		queryClient.setQueryData(['file', 'project-1', '/src/app.ts'], { path: '/src/app.ts', content: 'old content' });
		useStore.setState({ participants: [{ id: 'other-client', color: '#f97316' }] });

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();
		socket?.message(
			JSON.stringify({
				type: 'file-edited',
				id: 'other-client',
				path: '/src/app.ts',
				content: 'new content',
				cursor: { line: 3, ch: 7 },
				selection: { anchor: { line: 3, ch: 1 }, head: { line: 3, ch: 7 } },
			}),
		);

		expect(queryClient.getQueryData(['file', 'project-1', '/src/app.ts'])).toEqual({ path: '/src/app.ts', content: 'new content' });
		expect(useStore.getState().participants).toEqual([
			{
				id: 'other-client',
				color: '#f97316',
				file: '/src/app.ts',
				cursor: { line: 3, ch: 7 },
				selection: { anchor: { line: 3, ch: 1 }, head: { line: 3, ch: 7 } },
			},
		]);

		unmount();
	});

	it('preserves agent diff state when incoming human edits update the live file', async () => {
		const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'const value = 1;',
						afterContent: 'const value = 2;',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
			gitDiffView: {
				path: '/src/app.ts',
				beforeContent: 'const value = 1;',
				afterContent: 'const value = 2;',
			},
		});

		const { unmount } = renderHook(() => useProjectSocket({ projectId: 'project-1' }), { wrapper: createWrapper(queryClient) });

		await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
		const socket = FakeWebSocket.instances[0];
		expect(socket).toBeDefined();
		socket?.open();
		socket?.message(
			JSON.stringify({
				type: 'file-edited',
				id: 'other-client',
				path: '/src/app.ts',
				content: 'const value = 3;',
			}),
		);

		expect(queryClient.getQueryData(['file', 'project-1', '/src/app.ts'])).toEqual({ path: '/src/app.ts', content: 'const value = 3;' });
		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.afterContent).toBe('const value = 2;');
		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.hunkStatuses).toEqual(['pending']);
		expect(useStore.getState().gitDiffView?.afterContent).toBe('const value = 3;');

		unmount();
	});
});
