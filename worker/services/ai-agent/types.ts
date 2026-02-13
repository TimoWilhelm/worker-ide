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
