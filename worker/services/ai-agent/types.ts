/**
 * Types for the AI Agent Service.
 */

// =============================================================================
// Types
// =============================================================================

export interface AgentMessage {
	role: 'user' | 'assistant';
	content: ContentBlock[] | string;
}

export interface TextBlock {
	type: 'text';
	text: string;
}

export interface ToolUseBlock {
	type: 'tool_use';
	id: string;
	name: string;
	input: Record<string, string>;
}

export type ContentBlock = TextBlock | ToolUseBlock;

export interface ToolResultBlock {
	type: 'tool_result';
	tool_use_id: string;
	content: string;
}

export interface ClaudeResponse {
	id: string;
	type: string;
	role: string;
	content: ContentBlock[];
	stop_reason: string | null;
	stop_sequence: string | null;
}

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

export type SendEventFunction = (type: string, data: Record<string, unknown>) => Promise<void>;

export interface ToolExecutorContext {
	projectRoot: string;
	projectId: string;
	environment: Env;
	planMode: boolean;
	sessionId?: string;
	callMcpTool: (serverId: string, toolName: string, arguments_: Record<string, unknown>) => Promise<string>;
	repairToolCall: (toolName: string, rawInput: unknown, error: string, apiToken: string) => Promise<Record<string, unknown> | undefined>;
}

export type ToolExecuteFunction = (
	input: Record<string, string>,
	sendEvent: SendEventFunction,
	context: ToolExecutorContext,
	toolUseId?: string,
	queryChanges?: FileChange[],
) => Promise<string | object>;

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
