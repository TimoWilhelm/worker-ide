import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentRuntime } from './agent-runtime-context';
import { AgentRuntimeProvider } from './agent-runtime-provider';
import { createUnavailableAgentRunnerStub } from '../lib/agent-stub';

import type { ReactNode } from 'react';

type Listener = () => void;

interface MockAgent {
	identified: boolean;
	state: undefined;
	stub: ReturnType<typeof createUnavailableAgentRunnerStub>;
	addEventListener: (type: string, listener: Listener) => void;
	removeEventListener: (type: string, listener: Listener) => void;
}

const listenersByType = new Map<string, Set<Listener>>();
const mockAgent: MockAgent = {
	identified: false,
	state: undefined,
	stub: createUnavailableAgentRunnerStub(),
	addEventListener: vi.fn((type: string, listener: Listener) => {
		const listeners = listenersByType.get(type) ?? new Set<Listener>();
		listeners.add(listener);
		listenersByType.set(type, listeners);
	}),
	removeEventListener: vi.fn((type: string, listener: Listener) => {
		listenersByType.get(type)?.delete(listener);
	}),
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
	beforeEach(() => {
		listenersByType.clear();
		mockAgent.identified = false;
		localStorage.clear();
		vi.clearAllMocks();
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
});
