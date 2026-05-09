import { createContext, useContext } from 'react';

import type { AgentCallOptions } from '../lib/agent-call';
import type { InputSegment } from '../lib/input-segments';
import type { Dispatch, SetStateAction } from 'react';

export type AgentConnectionState = 'connecting' | 'connected' | 'disconnected';

export interface AgentRuntimeHandle {
	identified: boolean;
	state: unknown;
	addEventListener: (type: string, listener: () => void) => void;
	removeEventListener: (type: string, listener: () => void) => void;
	call: <T = unknown>(method: string, arguments_?: unknown[], options?: AgentCallOptions) => Promise<T>;
}

export interface AgentRuntimeValue {
	agent: AgentRuntimeHandle;
	agentConnectionState: AgentConnectionState;
	isConnected: boolean;
	segments: InputSegment[];
	setSegments: Dispatch<SetStateAction<InputSegment[]>>;
	cursorPosition: number;
	setCursorPosition: Dispatch<SetStateAction<number>>;
}

export const AgentRuntimeContext = createContext<AgentRuntimeValue | undefined>(undefined);

export function useAgentRuntime(): AgentRuntimeValue {
	const value = useContext(AgentRuntimeContext);
	if (!value) {
		throw new Error('useAgentRuntime must be used within AgentRuntimeProvider');
	}

	return value;
}
