import type { AgentState } from '@shared/agent-state';

export function isAgentState(value: unknown): value is AgentState {
	return value !== null && typeof value === 'object' && 'sessions' in value;
}
