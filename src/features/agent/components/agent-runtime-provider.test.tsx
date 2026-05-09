import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentRuntime } from './agent-runtime-context';
import { AgentRuntimeProvider } from './agent-runtime-provider';
import { AgentCallTimeoutError } from '../lib/agent-call';

import type { AgentCallOptions } from '../lib/agent-call';
import type { ReactNode } from 'react';

type Listener = () => void;

interface MockAgent {
	identified: boolean;
	addEventListener: (type: string, listener: Listener) => void;
	removeEventListener: (type: string, listener: Listener) => void;
	call: (method: string, arguments_?: unknown[], options?: AgentCallOptions) => Promise<unknown>;
}

const listenersByType = new Map<string, Set<Listener>>();
const mockAgentCall = vi.fn<(method: string, arguments_?: unknown[], options?: AgentCallOptions) => Promise<unknown>>(async () => {});
const mockAgent: MockAgent = {
	identified: false,
	addEventListener: vi.fn((type: string, listener: Listener) => {
		const listeners = listenersByType.get(type) ?? new Set<Listener>();
		listeners.add(listener);
		listenersByType.set(type, listeners);
	}),
	removeEventListener: vi.fn((type: string, listener: Listener) => {
		listenersByType.get(type)?.delete(listener);
	}),
	call: mockAgentCall,
};

vi.mock('agents/react', () => ({
	useAgent: () => ({ ...mockAgent }),
}));

function wrapper({ children }: { children: ReactNode }) {
	return <AgentRuntimeProvider projectId="project-1">{children}</AgentRuntimeProvider>;
}

function emit(type: string) {
	for (const listener of listenersByType.get(type) ?? []) {
		listener();
	}
}

function RuntimeHarness() {
	const { segments, setSegments, cursorPosition, setCursorPosition } = useAgentRuntime();

	return (
		<>
			<button type="button" onClick={() => setSegments([{ type: 'text', value: 'Keep this draft' }])}>
				Set draft
			</button>
			<button type="button" onClick={() => setCursorPosition(15)}>
				Set cursor
			</button>
			<output data-testid="draft-value">{JSON.stringify(segments)}</output>
			<output data-testid="cursor-value">{cursorPosition}</output>
		</>
	);
}

describe('AgentRuntimeProvider', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	beforeEach(() => {
		listenersByType.clear();
		mockAgent.identified = false;
		localStorage.clear();
		vi.clearAllMocks();
		mockAgentCall.mockReset();
		mockAgentCall.mockImplementation(async () => {});
	});

	it('retains the draft when the panel consumer remounts', () => {
		const { rerender } = render(
			<AgentRuntimeProvider projectId="project-1">
				<RuntimeHarness />
			</AgentRuntimeProvider>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Set draft' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set cursor' }));

		rerender(<AgentRuntimeProvider projectId="project-1">{undefined}</AgentRuntimeProvider>);
		rerender(
			<AgentRuntimeProvider projectId="project-1">
				<RuntimeHarness />
			</AgentRuntimeProvider>,
		);

		expect(screen.getByTestId('draft-value')).toHaveTextContent('[{"type":"text","value":"Keep this draft"}]');
		expect(screen.getByTestId('cursor-value')).toHaveTextContent('15');
	});

	it('restores the persisted draft after a provider remount', () => {
		const firstRender = render(
			<AgentRuntimeProvider projectId="project-1">
				<RuntimeHarness />
			</AgentRuntimeProvider>,
		);

		fireEvent.click(screen.getByRole('button', { name: 'Set draft' }));
		fireEvent.click(screen.getByRole('button', { name: 'Set cursor' }));

		firstRender.unmount();

		render(
			<AgentRuntimeProvider projectId="project-1">
				<RuntimeHarness />
			</AgentRuntimeProvider>,
		);

		expect(screen.getByTestId('draft-value')).toHaveTextContent('[{"type":"text","value":"Keep this draft"}]');
		expect(screen.getByTestId('cursor-value')).toHaveTextContent('15');
	});

	it('tracks connection state across socket lifecycle events', () => {
		const { result } = renderHook(() => useAgentRuntime(), { wrapper });

		expect(result.current.agentConnectionState).toBe('connecting');

		act(() => {
			emit('open');
		});

		expect(result.current.agentConnectionState).toBe('connected');

		act(() => {
			emit('close');
		});

		expect(result.current.agentConnectionState).toBe('disconnected');

		act(() => {
			emit('open');
		});

		expect(result.current.agentConnectionState).toBe('connected');
		expect(result.current.isConnected).toBe(true);
	});

	it('retries retryable agent calls before succeeding', async () => {
		mockAgentCall.mockRejectedValueOnce(new TypeError('Socket closed')).mockResolvedValueOnce('ok');
		const { result } = renderHook(() => useAgentRuntime(), { wrapper });

		await expect(result.current.agent.call('loadSession', ['session-1'], { retryDelayMs: 0 })).resolves.toBe('ok');
		expect(mockAgentCall).toHaveBeenCalledTimes(2);
	});

	it('times out agent calls that do not resolve', async () => {
		vi.useFakeTimers();
		mockAgentCall.mockImplementation(() => new Promise(() => {}));
		const { result } = renderHook(() => useAgentRuntime(), { wrapper });

		const promise = result.current.agent.call('abortRun', ['session-1'], { timeoutMs: 5, retryCount: 0 });
		const expectation = expect(promise).rejects.toBeInstanceOf(AgentCallTimeoutError);
		await vi.advanceTimersByTimeAsync(5);

		await expectation;
	});
});
