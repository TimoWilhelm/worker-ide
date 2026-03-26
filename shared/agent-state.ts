/**
 * Agent state types for the Agents SDK-based AgentRunner.
 *
 * The AgentState is auto-persisted to SQLite and auto-broadcast to all
 * connected clients via the Agents SDK. The frontend subscribes to state
 * updates via `useAgent({ onStateUpdate })` and renders accordingly.
 *
 * Design principles:
 * - Server is the sole source of truth for all AI session state.
 * - Frontend is a pure renderer — it reads state, never writes it.
 * - Actions dispatch via @callable RPC methods, not state mutations.
 * - Streaming content is delivered via @callable({ streaming: true }) RPC,
 *   NOT via high-frequency state updates (to avoid SQLite write storms).
 */

import type { AgentMode, AgentSessionStatus, ChatMessage, PendingFileChange, ToolErrorInfo, ToolMetadataInfo } from './types';

// =============================================================================
// Agent State
// =============================================================================

/**
 * The top-level state shape for the AgentRunner Durable Object.
 * Auto-synced to all connected clients via the Agents SDK.
 */
export interface AgentState {
	/** The currently active session, or undefined if no session is loaded. */
	currentSession: AgentSessionState | undefined;
	/** Summary list of all saved sessions (for the dropdown). */
	sessions: SessionSummary[];
}

/**
 * State of the currently active AI session.
 *
 * Updated by the server during generation. The frontend renders this
 * directly — no bi-directional sync or skip-flags needed.
 */
export interface AgentSessionState {
	/** Unique session identifier */
	sessionId: string;
	/** Session title (AI-generated or fallback) */
	title: string;
	/** Current execution status */
	status: AgentSessionStatus | 'idle';
	/** Complete message history (finalized messages only, not streaming) */
	messages: ChatMessage[];
	/** Human-readable status text ("Thinking...", "Retrying...", etc.) */
	statusText: string | undefined;
	/** Error from the last run, if any */
	error: { message: string; code?: string } | undefined;
	/** Estimated context window token usage */
	contextTokensUsed: number;
	/** Project-level pending file changes (keyed by file path) */
	pendingChanges: Record<string, PendingFileChange>;
	/** Maps message index → snapshot ID for revert buttons */
	messageSnapshots: Record<string, string>;
	/** Maps message index → agent mode badge */
	messageModes: Record<string, AgentMode>;
	/** Structured tool result metadata (keyed by toolCallId) */
	toolMetadata: Record<string, ToolMetadataInfo>;
	/** Structured tool error data (keyed by toolCallId) */
	toolErrors: Record<string, ToolErrorInfo>;
	/** ID of the latest debug log file */
	debugLogId: string | undefined;
	/** Steering messages queued but not yet consumed by the agent loop. */
	pendingSteeringMessages: PendingSteeringMessage[];
	/** Pending question from the agent (user_question tool). */
	pendingQuestion: { question: string; options: string } | undefined;
	/** Whether the agent hit the iteration limit and can be continued. */
	needsContinuation: boolean;
	/** Doom loop detection message, if triggered. */
	doomLoopMessage: string | undefined;
}

/**
 * A steering message queued by the user while the agent is running.
 * Displayed with a distinct "pending" style until consumed by the agent loop.
 */
export interface PendingSteeringMessage {
	id: string;
	content: string;
	createdAt: number;
}

/**
 * Summary of a saved session (for the sessions dropdown).
 */
export interface SessionSummary {
	id: string;
	title: string;
	createdAt: number;
	isRunning: boolean;
}

// =============================================================================
// Streaming Event Types
// =============================================================================

/**
 * Events streamed to the client via @callable({ streaming: true }) during
 * an active generation. These are ephemeral (not persisted to state) and
 * provide real-time token-by-token content and status updates.
 *
 * The client processes these in the `onChunk` callback and uses them to
 * build the in-progress assistant message for display.
 */
export type StreamEvent =
	| TextDeltaEvent
	| ReasoningDeltaEvent
	| ToolCallStartEvent
	| ToolCallArgumentsDeltaEvent
	| ToolCallEndEvent
	| ToolResultEvent
	| StatusEvent
	| FileChangedEvent
	| SnapshotCreatedEvent
	| SnapshotDeletedEvent
	| UserQuestionEvent
	| ContextUtilizationEvent
	| UsageEvent
	| TurnCompleteEvent
	| MaxIterationsReachedEvent
	| DoomLoopDetectedEvent
	| PlanCreatedEvent
	| RunFinishedEvent
	| RunErrorEvent;

/** A delta of text content from the assistant. */
export interface TextDeltaEvent {
	type: 'text-delta';
	delta: string;
}

/** A delta of reasoning/thinking content from the assistant. */
export interface ReasoningDeltaEvent {
	type: 'reasoning-delta';
	delta: string;
}

/** The start of a tool call. */
export interface ToolCallStartEvent {
	type: 'tool-call-start';
	toolCallId: string;
	toolName: string;
}

/** A delta of tool call arguments (JSON string fragment). */
export interface ToolCallArgumentsDeltaEvent {
	type: 'tool-call-args-delta';
	toolCallId: string;
	delta: string;
}

/** The end of a tool call (arguments finalized, execution starting). */
export interface ToolCallEndEvent {
	type: 'tool-call-end';
	toolCallId: string;
	toolName: string;
	result: string;
	isError?: boolean;
}

/** A structured tool result with metadata. */
export interface ToolResultEvent {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	title: string;
	metadata: Record<string, unknown>;
}

/** A status text update ("Thinking...", "Retrying...", etc.). */
export interface StatusEvent {
	type: 'status';
	message: string;
}

/** A file was changed by a tool. */
export interface FileChangedEvent {
	type: 'file-changed';
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	toolCallId: string | undefined;
}

/** A snapshot was created for this turn. */
export interface SnapshotCreatedEvent {
	type: 'snapshot-created';
	id: string;
}

/** An empty snapshot was cleaned up. */
export interface SnapshotDeletedEvent {
	type: 'snapshot-deleted';
	id: string;
}

/** The agent is asking the user a question. */
export interface UserQuestionEvent {
	type: 'user-question';
	question: string;
	options: string;
}

/** Context window utilization update. */
export interface ContextUtilizationEvent {
	type: 'context-utilization';
	estimatedTokens: number;
	contextWindow: number;
	utilization: number;
}

/** Token usage summary for the run. */
export interface UsageEvent {
	type: 'usage';
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
	lastTurnInputTokens: number;
}

/** A single agent iteration completed. */
export interface TurnCompleteEvent {
	type: 'turn-complete';
}

/** The agent hit the iteration limit. */
export interface MaxIterationsReachedEvent {
	type: 'max-iterations-reached';
	iterations: number;
}

/** The agent was stopped due to repetitive behavior. */
export interface DoomLoopDetectedEvent {
	type: 'doom-loop-detected';
	reason: string;
	toolName: string | undefined;
	message: string;
}

/** A plan file was created (plan mode). */
export interface PlanCreatedEvent {
	type: 'plan-created';
	path: string;
}

/** The generation run completed successfully. */
export interface RunFinishedEvent {
	type: 'run-finished';
}

/** The generation run encountered an error. */
export interface RunErrorEvent {
	type: 'run-error';
	message: string;
	code?: string;
}

/** Structured tool error info from a failed tool call. */
export interface ToolErrorEvent {
	type: 'tool-error';
	toolCallId: string;
	toolName: string;
	errorCode: string;
	errorMessage: string;
}
