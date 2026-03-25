/**
 * Stream Event Helpers.
 *
 * Pure utility functions for constructing typed StreamEvent objects.
 * Constructs strongly-typed StreamEvent objects for the agent stream.
 */

import type {
	ContextUtilizationEvent,
	DoomLoopDetectedEvent,
	FileChangedEvent,
	MaxIterationsReachedEvent,
	PlanCreatedEvent,
	ReasoningDeltaEvent,
	RunErrorEvent,
	SnapshotCreatedEvent,
	SnapshotDeletedEvent,
	StatusEvent,
	StreamEvent,
	TextDeltaEvent,
	ToolCallArgumentsDeltaEvent,
	ToolCallEndEvent,
	ToolCallStartEvent,
	ToolResultEvent,
	TurnCompleteEvent,
	UsageEvent,
	UserQuestionEvent,
} from '@shared/agent-state';

// =============================================================================
// Event Constructors
// =============================================================================

export function statusEvent(message: string): StatusEvent {
	return { type: 'status', message };
}

export function textDeltaEvent(delta: string): TextDeltaEvent {
	return { type: 'text-delta', delta };
}

export function reasoningDeltaEvent(delta: string): ReasoningDeltaEvent {
	return { type: 'reasoning-delta', delta };
}

export function toolCallStartEvent(toolCallId: string, toolName: string): ToolCallStartEvent {
	return { type: 'tool-call-start', toolCallId, toolName };
}

export function toolCallArgumentsDeltaEvent(toolCallId: string, delta: string): ToolCallArgumentsDeltaEvent {
	return { type: 'tool-call-args-delta', toolCallId, delta };
}

export function toolCallEndEvent(toolCallId: string, toolName: string, result: string, isError?: boolean): ToolCallEndEvent {
	return { type: 'tool-call-end', toolCallId, toolName, result, isError };
}

function toolResultEvent(toolCallId: string, toolName: string, title: string, metadata: Record<string, unknown>): ToolResultEvent {
	return { type: 'tool-result', toolCallId, toolName, title, metadata };
}

function fileChangedEvent(
	path: string,
	action: 'create' | 'edit' | 'delete' | 'move',
	beforeContent: string | undefined,
	afterContent: string | undefined,
	toolCallId: string | undefined,
): FileChangedEvent {
	return { type: 'file-changed', path, action, beforeContent, afterContent, toolCallId };
}

function snapshotCreatedEvent(id: string): SnapshotCreatedEvent {
	return { type: 'snapshot-created', id };
}

export function snapshotDeletedEvent(id: string): SnapshotDeletedEvent {
	return { type: 'snapshot-deleted', id };
}

function userQuestionEvent(question: string, options: string): UserQuestionEvent {
	return { type: 'user-question', question, options };
}

export function contextUtilizationEvent(estimatedTokens: number, contextWindow: number, utilization: number): ContextUtilizationEvent {
	return { type: 'context-utilization', estimatedTokens, contextWindow, utilization };
}

export function usageEvent(
	input: number,
	output: number,
	cacheRead: number,
	cacheWrite: number,
	turns: number,
	lastTurnInputTokens: number,
): UsageEvent {
	return { type: 'usage', input, output, cacheRead, cacheWrite, turns, lastTurnInputTokens };
}

export function turnCompleteEvent(): TurnCompleteEvent {
	return { type: 'turn-complete' };
}

export function maxIterationsReachedEvent(iterations: number): MaxIterationsReachedEvent {
	return { type: 'max-iterations-reached', iterations };
}

export function doomLoopDetectedEvent(reason: string, toolName: string | undefined, message: string): DoomLoopDetectedEvent {
	return { type: 'doom-loop-detected', reason, toolName, message };
}

export function planCreatedEvent(path: string): PlanCreatedEvent {
	return { type: 'plan-created', path };
}

export function runErrorEvent(message: string, code?: string): RunErrorEvent {
	return { type: 'run-error', message, code };
}

// =============================================================================
// Internal helpers
// =============================================================================

function isRecordObject(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

const FILE_ACTIONS = new Set(['create', 'edit', 'delete', 'move']);
function isFileAction(value: unknown): value is 'create' | 'edit' | 'delete' | 'move' {
	return typeof value === 'string' && FILE_ACTIONS.has(value);
}

// =============================================================================
// SendEvent factory (used by tool executors)
// =============================================================================

/**
 * Create a SendEvent function that pushes StreamEvent objects into a queue.
 *
 * The `toolCallIdReference` is a mutable ref set by the tool wrapper before
 * execution, allowing events to be auto-tagged with the current tool call ID.
 */
export function createSendEventFunction(
	queue: StreamEvent[],
	toolCallIdReference: { current: string | undefined },
	signal: AbortSignal,
): (type: string, data: Record<string, unknown>) => void {
	return (type: string, data: Record<string, unknown>) => {
		if (signal.aborted) return;

		const toolCallId = toolCallIdReference.current;

		// Map legacy event names to typed StreamEvent objects
		switch (type) {
			case 'status': {
				queue.push(statusEvent(String(data.message ?? '')));
				break;
			}
			case 'file_changed': {
				const action = isFileAction(data.action) ? data.action : 'edit';
				queue.push(
					fileChangedEvent(
						String(data.path ?? ''),
						action,
						typeof data.beforeContent === 'string' ? data.beforeContent : undefined,
						typeof data.afterContent === 'string' ? data.afterContent : undefined,
						typeof data.tool_use_id === 'string' ? data.tool_use_id : toolCallId,
					),
				);
				break;
			}
			case 'user_question': {
				queue.push(userQuestionEvent(String(data.question ?? ''), String(data.options ?? '')));
				break;
			}
			case 'snapshot_created': {
				queue.push(snapshotCreatedEvent(String(data.id ?? '')));
				break;
			}
			case 'snapshot_deleted': {
				queue.push(snapshotDeletedEvent(String(data.id ?? '')));
				break;
			}
			case 'plan_created': {
				queue.push(planCreatedEvent(String(data.path ?? '')));
				break;
			}
			default: {
				// For tool_result events, construct typed event
				if (type === 'tool_result') {
					const rawMetadata = data.metadata;
					const metadataRecord: Record<string, unknown> = isRecordObject(rawMetadata) ? rawMetadata : {};
					queue.push(
						toolResultEvent(
							typeof data.toolCallId === 'string' ? data.toolCallId : (toolCallId ?? ''),
							String(data.tool_name ?? ''),
							String(data.title ?? ''),
							metadataRecord,
						),
					);
				}
				break;
			}
		}
	};
}
