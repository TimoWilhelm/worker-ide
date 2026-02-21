/**
 * Types for the AI Agent Service.
 */

import type { StreamChunk } from '@tanstack/ai';

// =============================================================================
// Types
// =============================================================================

/**
 * Re-export TanStack AI's ModelMessage as our message type.
 */

export interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | Uint8Array | null;
	afterContent: string | Uint8Array | null;
	isBinary: boolean;
}

export interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	changes: Array<{ path: string; action: 'create' | 'edit' | 'delete' }>;
}

export type TodoItem = {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
};

/**
 * A queue of CUSTOM AG-UI events that tools push into during execution.
 * The stream wrapper drains this queue between AG-UI events from chat().
 */
export type CustomEventQueue = StreamChunk[];

/**
 * Function to emit a CUSTOM AG-UI event from a tool executor.
 * Pushes events into the shared CustomEventQueue which is drained
 * by the stream wrapper and sent to the client.
 */
export type SendEventFunction = (type: string, data: Record<string, unknown>) => void;

/**
 * Context passed to tool execute functions.
 * This is captured in closures when creating tool definitions.
 */
export interface ToolExecutorContext {
	projectRoot: string;
	projectId: string;
	mode: 'code' | 'plan' | 'ask';
	sessionId?: string;
	callMcpTool: (serverId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<string>;
	sendCdpCommand?: (id: string, method: string, parameters?: Record<string, unknown>) => Promise<{ result?: string; error?: string }>;
}

/**
 * Tool execute function signature.
 * Used by individual tool modules, wrapped into TanStack AI tools by tools/index.ts.
 */
export type ToolExecuteFunction = (
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
) => Promise<string | object>;

/**
 * Tool definition shape used by individual tool modules.
 * The tools/index.ts barrel wraps these into TanStack AI toolDefinition().server() format.
 */
export interface ToolDefinition {
	name: string;
	description: string;
	input_schema: {
		type: string;
		properties: Record<string, unknown>;
		required?: string[];
	};
}

export interface ToolModule {
	definition: ToolDefinition;
	execute: ToolExecuteFunction;
}

export type { AgentDebugLog, AgentDebugLogSummary, AgentLogEntry, LogCategory, LogLevel } from './agent-logger';
export { type ModelMessage } from '@tanstack/ai';
