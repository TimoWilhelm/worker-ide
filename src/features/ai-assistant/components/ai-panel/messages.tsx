/**
 * AI Panel Message Sub-Components.
 * WelcomeScreen, MessageBubble, UserMessage, AssistantMessage,
 * InlineToolCall, InlineTodoList, ContinuationPrompt, AIError.
 *
 * Renders UIMessage.parts (TextPart, ToolCallPart, ToolResultPart, ThinkingPart)
 * from TanStack AI.
 */

import {
	AlertCircle,
	Bot,
	CheckCircle2,
	CheckSquare,
	ChevronRight,
	Circle,
	Clock,
	Eye,
	FastForward,
	FileText,
	FolderSearch,
	Globe,
	HelpCircle,
	ListTodo,
	Loader2,
	Map as MapIcon,
	MoveRight,
	Pencil,
	PlayCircle,
	RefreshCw,
	RotateCcw,
	Search,
	Trash2,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Pill, type PillProperties } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { computeDiffHunks } from '@/features/editor/lib/diff-decorations';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TOOL_ERROR_LABELS } from '@shared/tool-errors';

import { AI_SUGGESTIONS, isRecord, isToolName } from './helpers';
import { parseTextToSegments } from '../../lib/input-segments';
import { FileReference } from '../file-reference';
import { MarkdownContent } from '../markdown-content';

import type { AgentMode, ToolErrorInfo, ToolMetadataInfo, UIMessage } from '@shared/types';
import type { ToolName } from '@shared/validation';

/** Threshold in pixels — if within this distance of bottom, consider "at bottom" for the thinking box. */
const THINKING_BOX_BOTTOM_THRESHOLD = 16;

// =============================================================================
// Part type helpers (for narrowing UIMessage parts)
// =============================================================================

interface TextPart {
	type: 'text';
	content: string;
}

interface ToolCallPart {
	type: 'tool-call';
	id: string;
	name: string;
	arguments: string;
	input?: unknown;
	state: string;
	output?: unknown;
}

interface ToolResultPart {
	type: 'tool-result';
	toolCallId: string;
	content: string;
	state: string;
	error?: string;
}

interface ThinkingPart {
	type: 'thinking';
	content: string;
}

function isTextPart(part: unknown): part is TextPart {
	return isRecord(part) && part.type === 'text' && typeof part.content === 'string';
}

function isToolCallPart(part: unknown): part is ToolCallPart {
	return isRecord(part) && part.type === 'tool-call' && typeof part.id === 'string';
}

function isToolResultPart(part: unknown): part is ToolResultPart {
	return isRecord(part) && part.type === 'tool-result' && typeof part.toolCallId === 'string';
}

function isThinkingPart(part: unknown): part is ThinkingPart {
	return isRecord(part) && part.type === 'thinking' && typeof part.content === 'string';
}

// =============================================================================
// Tool icon helper
// =============================================================================

function ToolIcon({ name, className }: { name: ToolName; className?: string }) {
	switch (name) {
		case 'file_read':
		case 'files_list': {
			return <Eye className={cn('size-3', className)} />;
		}
		case 'file_edit':
		case 'file_write': {
			return <Pencil className={cn('size-3', className)} />;
		}
		case 'file_delete': {
			return <Trash2 className={cn('size-3', className)} />;
		}
		case 'file_move': {
			return <MoveRight className={cn('size-3', className)} />;
		}
		case 'file_grep': {
			return <Search className={cn('size-3', className)} />;
		}
		case 'file_glob':
		case 'file_list': {
			return <FolderSearch className={cn('size-3', className)} />;
		}
		case 'user_question': {
			return <HelpCircle className={cn('size-3', className)} />;
		}
		case 'web_fetch':
		case 'docs_search': {
			return <Globe className={cn('size-3', className)} />;
		}
		case 'todos_get': {
			return <ListTodo className={cn('size-3', className)} />;
		}
		case 'todos_update': {
			return <CheckSquare className={cn('size-3', className)} />;
		}
		case 'plan_update': {
			return <MapIcon className={cn('size-3', className)} />;
		}
		default: {
			return <FileText className={cn('size-3', className)} />;
		}
	}
}

// =============================================================================
// Welcome Screen
// =============================================================================

export function WelcomeScreen({
	onSuggestionClick,
	onModeChange,
}: {
	onSuggestionClick: (prompt: string) => void;
	onModeChange: (mode: AgentMode) => void;
}) {
	return (
		<div className="flex flex-col items-center justify-center py-8 text-center">
			<div className="mb-3 text-accent opacity-70">
				<Bot className="size-8" />
			</div>
			<p className="max-w-[250px] text-sm/relaxed text-text-secondary">
				Ask me to help with your code. I can read, create and edit files in your project.
			</p>
			<div className="mt-4 flex flex-wrap justify-center gap-2">
				{AI_SUGGESTIONS.map((suggestion) => (
					<button
						key={suggestion.label}
						onClick={() => {
							onModeChange(suggestion.mode);
							onSuggestionClick(suggestion.prompt);
						}}
						className={cn(
							`
								cursor-pointer rounded-full border border-border bg-bg-tertiary px-3
								py-1.5 text-xs
							`,
							'text-text-secondary transition-colors',
							'hover:border-text-secondary hover:text-text-primary',
						)}
					>
						{suggestion.label}
					</button>
				))}
			</div>
		</div>
	);
}

// =============================================================================
// Message Bubble
// =============================================================================

export function MessageBubble({
	message,
	messageIndex,
	snapshotId,
	isReverting,
	revertingMessageIndex,
	onRevert,
	toolErrors,
	toolMetadata,
	fileDiffContent,
}: {
	message: UIMessage;
	messageIndex: number;
	snapshotId?: string;
	/** Whether any revert operation is in progress (disables all revert buttons) */
	isReverting: boolean;
	/** The message index currently being reverted (shows spinner on that specific button) */
	revertingMessageIndex?: number;
	onRevert: (snapshotId: string, messageIndex: number) => void;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
}) {
	if (message.role === 'user') {
		return (
			<UserMessage
				message={message}
				messageIndex={messageIndex}
				snapshotId={snapshotId}
				isReverting={isReverting}
				isRevertingThis={revertingMessageIndex === messageIndex}
				onRevert={onRevert}
			/>
		);
	}

	return <AssistantMessage message={message} toolErrors={toolErrors} toolMetadata={toolMetadata} fileDiffContent={fileDiffContent} />;
}

// =============================================================================
// User Message
// =============================================================================

function UserMessage({
	message,
	messageIndex,
	snapshotId,
	isReverting,
	isRevertingThis,
	onRevert,
}: {
	message: UIMessage;
	messageIndex: number;
	snapshotId?: string;
	/** Whether any revert operation is in progress (disables this button) */
	isReverting: boolean;
	/** Whether this specific message is being reverted (shows spinner) */
	isRevertingThis: boolean;
	onRevert: (snapshotId: string, messageIndex: number) => void;
}) {
	const text = message.parts
		.filter((part) => isTextPart(part))
		.map((part) => part.content)
		.join('\n');

	// Build a set of known file paths to identify file mentions
	const files = useStore((state) => state.files);
	const knownPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
	const segments = useMemo(() => parseTextToSegments(text, knownPaths), [text, knownPaths]);

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1">
			<div className="flex items-center justify-between">
				<div className="text-2xs font-semibold tracking-wider text-accent uppercase">You</div>
				{snapshotId && (
					<Tooltip content="Revert files to before this message">
						<button
							onClick={() => onRevert(snapshotId, messageIndex)}
							disabled={isReverting}
							className={cn(
								'inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5',
								'text-2xs font-medium text-text-secondary transition-colors',
								'hover:bg-warning/10 hover:text-warning',
								isReverting && 'cursor-not-allowed opacity-50',
							)}
						>
							{isRevertingThis ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
							{isRevertingThis ? 'Reverting...' : 'Revert'}
						</button>
					</Tooltip>
				)}
			</div>
			<div className={cn(`rounded-lg border border-accent/20 bg-accent/10 px-3 py-2.5`, `text-sm/relaxed text-text-primary`)}>
				<span className="whitespace-pre-wrap">
					{segments.map((segment, index) =>
						segment.type === 'mention' ? <FileReference key={index} path={segment.path} /> : <span key={index}>{segment.value}</span>,
					)}
				</span>
			</div>
		</div>
	);
}

// =============================================================================
// Assistant Message
// =============================================================================

/**
 * Build a list of renderable segments from UIMessage parts, preserving order.
 * Groups adjacent text parts, pairs tool-call with their tool-result.
 */
type RenderSegment =
	| { kind: 'text'; key: string; text: string }
	| { kind: 'thinking'; key: string; text: string }
	| { kind: 'tool'; key: string; toolCall: ToolCallPart; toolResult?: ToolResultPart };

function buildRenderSegments(parts: unknown[]): RenderSegment[] {
	const segments: RenderSegment[] = [];

	// Collect tool results into a lookup so we can pair them with tool calls
	const resultsByCallId = new Map<string, ToolResultPart>();
	for (const part of parts) {
		if (isToolResultPart(part)) {
			resultsByCallId.set(part.toolCallId, part);
		}
	}

	// Counters for generating stable keys per segment kind
	let textCount = 0;
	let thinkingCount = 0;

	for (const part of parts) {
		if (isTextPart(part)) {
			const raw = part.content.trim();
			if (!raw) continue;
			// Merge consecutive text segments
			const last = segments.at(-1);
			if (last?.kind === 'text') {
				last.text += '\n' + raw;
			} else {
				segments.push({ kind: 'text', key: `text-${textCount++}`, text: raw });
			}
		} else if (isThinkingPart(part)) {
			const cleaned = part.content.trim();
			if (!cleaned) continue;
			segments.push({ kind: 'thinking', key: `thinking-${thinkingCount++}`, text: cleaned });
		} else if (isToolCallPart(part)) {
			const result = resultsByCallId.get(part.id);
			segments.push({ kind: 'tool', key: part.id, toolCall: part, toolResult: result });
		}
		// tool-result parts are consumed via the lookup above
	}
	return segments;
}

export function AssistantMessage({
	message,
	streaming,
	toolErrors,
	toolMetadata,
	fileDiffContent,
}: {
	message: UIMessage;
	streaming?: boolean;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
}) {
	const segments = buildRenderSegments(message.parts);
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
	const scrollReference = useRef<HTMLDivElement>(null);
	const userScrolledAwayReference = useRef(false);

	const hasToolCalls = segments.some((segment) => segment.kind === 'tool');
	const lastTextIndex = segments.findLastIndex((segment) => segment.kind === 'text');

	// Auto-scroll the active streaming thinking box (respects user scroll-up)
	useEffect(() => {
		if (streaming && scrollReference.current && !userScrolledAwayReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [streaming, message.parts]);

	// Reset scroll-away flag when streaming starts (new thinking box appears)
	useEffect(() => {
		if (streaming) {
			userScrolledAwayReference.current = false;
		}
	}, [streaming]);

	const handleThinkingBoxScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
		const element = event.currentTarget;
		const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
		userScrolledAwayReference.current = distanceFromBottom > THINKING_BOX_BOTTOM_THRESHOLD;
	}, []);

	const toggleSection = (key: string) => {
		setExpandedSections((previous) => {
			const next = new Set(previous);
			if (next.has(key)) {
				next.delete(key);
			} else {
				next.add(key);
			}
			return next;
		});
	};

	// Simple Q&A mode: no tool calls and not streaming — render text normally
	if (!hasToolCalls && !streaming) {
		return (
			<div className="flex min-w-0 animate-chat-item flex-col gap-2">
				<div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>
				{segments.map((segment) => {
					if (segment.kind === 'text') {
						return (
							<div
								key={segment.key}
								className="
									overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
									text-text-primary
								"
							>
								<MarkdownContent content={segment.text} />
							</div>
						);
					}
					if (segment.kind === 'thinking') {
						const isExpanded = expandedSections.has(segment.key);
						return (
							<div key={segment.key} className="flex flex-col gap-1.5">
								<button
									type="button"
									onClick={() => toggleSection(segment.key)}
									className={cn(
										`
											flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5
											text-xs
										`,
										`
											cursor-pointer bg-bg-tertiary font-medium text-text-secondary
											transition-colors
											hover:bg-border
										`,
									)}
								>
									<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
									Show thinking
								</button>
								{isExpanded && (
									<div
										className="
											overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
											text-text-primary
										"
									>
										<MarkdownContent content={segment.text} />
									</div>
								)}
							</div>
						);
					}
					return;
				})}
			</div>
		);
	}

	// Interleaved thinking + tool calls + summary layout
	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-2">
			<div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>
			{segments.map((segment, index) => {
				// Tool calls — always rendered inline
				if (segment.kind === 'tool') {
					return (
						<InlineToolCall
							key={segment.key}
							toolCall={segment.toolCall}
							toolResult={segment.toolResult}
							toolErrors={toolErrors}
							toolMetadata={toolMetadata}
							fileDiffContent={fileDiffContent}
							isExpanded={expandedSections.has(segment.key)}
							onToggleExpand={() => toggleSection(segment.key)}
						/>
					);
				}

				// Thinking segments — collapsible
				if (segment.kind === 'thinking') {
					const isExpanded = expandedSections.has(segment.key);
					return (
						<div key={segment.key} className="flex flex-col gap-1.5">
							<button
								type="button"
								onClick={() => toggleSection(segment.key)}
								className={cn(
									`
										flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs
									`,
									`
										cursor-pointer bg-bg-tertiary font-medium text-text-secondary
										transition-colors
										hover:bg-border
									`,
								)}
							>
								<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
								Show thinking
							</button>
							{isExpanded && (
								<div
									className="
										overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
										text-text-primary
									"
								>
									<MarkdownContent content={segment.text} />
								</div>
							)}
						</div>
					);
				}

				const isLastText = index === lastTextIndex;

				// Summary: last text segment of a completed (non-streaming) message
				if (isLastText && !streaming) {
					return (
						<div
							key={segment.key}
							className="
								overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
								text-text-primary
							"
						>
							<MarkdownContent content={segment.text} />
						</div>
					);
				}

				// Active streaming thinking box: constrained height + typing cursor
				if (isLastText && streaming) {
					return (
						<div
							key={segment.key}
							ref={scrollReference}
							onScroll={handleThinkingBoxScroll}
							className="
								max-h-48 overflow-y-auto rounded-lg border border-accent/20
								bg-bg-tertiary
							"
						>
							<div className="p-2.5">
								<div className="overflow-hidden text-sm/relaxed text-text-primary">
									<MarkdownContent content={segment.text} />
								</div>
							</div>
						</div>
					);
				}

				// Earlier text segments: collapsible thinking (intermediate reasoning between tool calls)
				{
					const isExpanded = expandedSections.has(segment.key);
					return (
						<div key={segment.key} className="flex flex-col gap-1.5">
							<button
								type="button"
								onClick={() => toggleSection(segment.key)}
								className={cn(
									`
										flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs
									`,
									`
										cursor-pointer bg-bg-tertiary font-medium text-text-secondary
										transition-colors
										hover:bg-border
									`,
								)}
							>
								<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
								Show thinking
							</button>
							{isExpanded && (
								<div
									className="
										overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
										text-text-primary
									"
								>
									<MarkdownContent content={segment.text} />
								</div>
							)}
						</div>
					);
				}
			})}
		</div>
	);
}

// =============================================================================
// Inline Tool Call
// =============================================================================

// =============================================================================
// Tool result parsing helpers
// =============================================================================

/**
 * Parsed stats from a structured file-editing tool result.
 * Tools like file_edit, file_write, lint_fix return JSON objects
 * with a `result` field (diff or summary) and numeric stats.
 */
interface FileEditResultStats {
	result: string;
	linesAdded: number;
	linesRemoved: number;
	lintErrorCount: number;
}

/**
 * Try to parse a structured file-edit result from a raw tool result string.
 * Returns undefined if the result is not a structured edit result.
 */
function parseFileEditResult(rawResult: string): FileEditResultStats | undefined {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (
			isRecord(parsed) &&
			typeof parsed.result === 'string' &&
			typeof parsed.linesAdded === 'number' &&
			typeof parsed.linesRemoved === 'number' &&
			typeof parsed.lintErrorCount === 'number'
		) {
			return {
				result: parsed.result,
				linesAdded: parsed.linesAdded,
				linesRemoved: parsed.linesRemoved,
				lintErrorCount: parsed.lintErrorCount,
			};
		}
	} catch {
		// Not JSON or wrong shape
	}
	return undefined;
}

/**
 * Extract text content from an XML-like tag, e.g. `<error>msg</error>` -> `msg`.
 * Returns undefined if the tag is not found.
 */
function extractTag(text: string, tag: string): string | undefined {
	const openTag = `<${tag}>`;
	const closeTag = `</${tag}>`;
	const start = text.indexOf(openTag);
	const end = text.indexOf(closeTag);
	if (start === -1 || end === -1) return undefined;
	return text.slice(start + openTag.length, end).trim();
}

/**
 * Check whether the tool result text represents an error.
 *
 * Error formats from TanStack AI:
 * - `[CODE] message` — ToolExecutionError thrown by our tool executors
 * - `Error executing tool: ...` — unexpected throw caught by TanStack AI
 * - `Input validation failed...` — Zod schema validation failure
 */
function isErrorResult(text: string): boolean {
	return /^\[[A-Z_]+\] /.test(text) || text.startsWith('Error executing tool:') || text.startsWith('Input validation failed');
}

/** Lookup table typed as a plain record so we can index with an arbitrary string. */
const errorLabels: Record<string, string> = TOOL_ERROR_LABELS;

/**
 * Get a short label from a structured ToolErrorInfo.
 * Uses the typed errorCode directly instead of regex-parsing `[CODE] message`.
 */
function shortenErrorFromStructured(error: ToolErrorInfo): string {
	if (error.errorCode) {
		const label = errorLabels[error.errorCode];
		if (label) return label;
	}
	// Strip the [CODE] prefix from errorMessage if present (ToolExecutionError format)
	const stripped = error.errorMessage.replace(/^\[[A-Z_]+\] /, '');
	return stripped.length > 40 ? stripped.slice(0, 40) + '...' : stripped || 'Error';
}

/**
 * Get a short label for an error.
 *
 * Extracts the error code from `[CODE] message` format and maps it to a
 * human-readable label. Falls back to truncating the message.
 */
function shortenError(text: string): string {
	// ToolExecutionError format: "[CODE] message"
	const bracketMatch = text.match(/^\[([A-Z_]+)\] (.*)/);
	if (bracketMatch) {
		const code = bracketMatch[1];
		const label = errorLabels[code];
		if (label) return label;
		const message = bracketMatch[2];
		return message.length > 40 ? message.slice(0, 40) + '...' : message;
	}

	// Framework-level errors
	if (text.startsWith('Error executing tool: ')) {
		const message = text.slice('Error executing tool: '.length);
		return message.length > 40 ? message.slice(0, 40) + '...' : message;
	}
	if (text.startsWith('Input validation failed')) {
		return 'Validation failed';
	}
	return text.length > 40 ? text.slice(0, 40) + '...' : 'Error';
}

/**
 * Build a brief summary from structured metadata (CUSTOM tool_result event).
 * Returns undefined if no meaningful summary can be derived, so the caller
 * falls back to raw-parsing.
 */
function summarizeFromMetadata(toolName: ToolName | undefined, info: ToolMetadataInfo): string | undefined {
	const { metadata } = info;

	switch (toolName) {
		case 'file_read': {
			if (metadata.type === 'directory' && typeof metadata.entryCount === 'number') {
				return `${metadata.entryCount} entr${metadata.entryCount === 1 ? 'y' : 'ies'}`;
			}
			if (metadata.type === 'binary') return 'Binary file';
			if (metadata.type === 'file' && typeof metadata.lineCount === 'number') {
				return `${metadata.lineCount} line${metadata.lineCount === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'file_edit': {
			return 'Applied';
		}

		case 'file_multiedit': {
			if (typeof metadata.editCount === 'number') {
				return `${metadata.editCount} edit${metadata.editCount === 1 ? '' : 's'} applied`;
			}
			return 'Applied';
		}

		case 'file_write': {
			return 'Written';
		}

		case 'file_delete': {
			return 'Deleted';
		}

		case 'file_move': {
			return 'Moved';
		}

		case 'file_glob': {
			if (typeof metadata.count === 'number') {
				if (metadata.count === 0) return 'No files found';
				return `${metadata.count} file${metadata.count === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'file_grep': {
			if (typeof metadata.matchCount === 'number') {
				if (metadata.matchCount === 0) return 'No matches';
				return `${metadata.matchCount} match${metadata.matchCount === 1 ? '' : 'es'}`;
			}
			return undefined;
		}

		case 'file_list': {
			if (Array.isArray(metadata.entries)) {
				const count = metadata.entries.length;
				return `${count} entr${count === 1 ? 'y' : 'ies'}`;
			}
			if (typeof metadata.count === 'number') {
				return `${metadata.count} entr${metadata.count === 1 ? 'y' : 'ies'}`;
			}
			// Fall through to raw-result parsing which reliably counts entries
			return undefined;
		}

		case 'files_list': {
			if (typeof metadata.count === 'number') {
				return `${metadata.count} file${metadata.count === 1 ? '' : 's'}`;
			}
			// Fall through to raw-result parsing
			return undefined;
		}

		case 'lint_check': {
			if (typeof metadata.issueCount === 'number') {
				if (metadata.issueCount === 0) return 'No issues';
				return `${metadata.issueCount} issue${metadata.issueCount === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'lint_fix': {
			return 'Fixed';
		}

		case 'dependencies_list': {
			if (isRecord(metadata.dependencies)) {
				const count = Object.keys(metadata.dependencies).length;
				return `${count} dep${count === 1 ? '' : 's'}`;
			}
			return undefined;
		}

		case 'dependencies_update': {
			if (typeof metadata.action === 'string' && typeof metadata.name === 'string') {
				const verb = metadata.action === 'add' ? 'Added' : metadata.action === 'remove' ? 'Removed' : 'Updated';
				return `${verb} ${metadata.name}`;
			}
			return undefined;
		}

		case 'plan_update': {
			if (typeof metadata.completedTasks === 'number' && typeof metadata.totalTasks === 'number') {
				return `${metadata.completedTasks}/${metadata.totalTasks}`;
			}
			return undefined;
		}

		case 'todos_get': {
			return 'Retrieved';
		}

		case 'todos_update': {
			return 'Updated';
		}

		case 'web_fetch': {
			if (typeof metadata.contentLength === 'number') {
				return `${metadata.contentLength} chars`;
			}
			return undefined;
		}

		case 'docs_search': {
			return 'Results fetched';
		}

		case 'cdp_eval': {
			if (typeof metadata.method === 'string') {
				return metadata.method;
			}
			return undefined;
		}

		case 'user_question': {
			return undefined;
		}

		default: {
			return undefined;
		}
	}
}

/**
 * Parse a tool result string into a brief human-readable summary.
 * Each tool gets a custom parser; falls back to a cleaned-up truncation.
 * Used as a fallback when structured metadata is not available (loaded sessions).
 */
function summarizeToolResult(toolName: ToolName, rawResult: string): string {
	// Handle errors first — applies to all tools
	if (isErrorResult(rawResult)) {
		return shortenError(rawResult);
	}

	switch (toolName) {
		case 'file_read': {
			const type = extractTag(rawResult, 'type');
			if (type === 'directory') {
				const entries = extractTag(rawResult, 'entries');
				if (entries) {
					const count = entries.split('\n').filter(Boolean).length;
					return `${count} entr${count === 1 ? 'y' : 'ies'}`;
				}
				return 'Directory';
			}
			if (type === 'binary') return 'Binary file';
			const content = extractTag(rawResult, 'content');
			if (content) {
				const lines = content.split('\n').filter(Boolean);
				return `${lines.length} line${lines.length === 1 ? '' : 's'}`;
			}
			return 'Read';
		}

		case 'file_edit': {
			const stats = parseFileEditResult(rawResult);
			if (stats) return 'Applied';
			if (rawResult.includes('No changes needed')) return 'No changes';
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult || 'Applied';
		}

		case 'file_multiedit': {
			const stats = parseFileEditResult(rawResult);
			if (stats) return 'Applied';
			if (rawResult.includes('No changes needed')) return 'No changes';
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult || 'Applied';
		}

		case 'file_write': {
			const stats = parseFileEditResult(rawResult);
			if (stats) return 'Written';
			return 'Written';
		}

		case 'lint_check': {
			if (rawResult.includes('No lint issues')) return 'No issues';
			const issueMatch = rawResult.match(/^Found (\d+) lint issue/);
			if (issueMatch) return `${issueMatch[1]} issue${issueMatch[1] === '1' ? '' : 's'}`;
			return 'Checked';
		}

		case 'lint_fix': {
			const stats = parseFileEditResult(rawResult);
			if (stats) return 'Fixed';
			return rawResult.includes('No lint issues') ? 'No issues' : 'Fixed';
		}

		case 'file_delete': {
			return 'Deleted';
		}

		case 'file_move': {
			return 'Moved';
		}

		case 'plan_update': {
			const result = extractResultField(rawResult);
			if (result) {
				// Extract progress info like "3/7 tasks completed"
				const progress = result.match(/(\d+\/\d+) tasks/);
				if (progress) return progress[1];
			}
			return 'Updated';
		}

		case 'dependencies_update': {
			// Output is plain text like "Added express@*" or "Removed lodash@4.17.21"
			const depMatch = rawResult.match(/^(Added|Removed|Updated) (\S+)/);
			if (depMatch) return `${depMatch[1]} ${depMatch[2].split('@')[0]}`;
			return 'Updated';
		}

		case 'dependencies_list': {
			// Output is "name: version" lines (plain text, not JSON)
			if (rawResult === 'No dependencies registered.' || rawResult === 'No project metadata found.') return '0 deps';
			const deps = rawResult.split('\n').filter(Boolean);
			return `${deps.length} dep${deps.length === 1 ? '' : 's'}`;
		}

		case 'cdp_eval': {
			// Output is "Method: X\n\nResult: ..." (plain text, not JSON)
			const methodMatch = rawResult.match(/^Method: (.+)/);
			if (methodMatch) return methodMatch[1];
			return 'Evaluated';
		}

		case 'todos_get': {
			return 'Retrieved';
		}

		case 'todos_update': {
			return 'Updated';
		}

		case 'file_grep': {
			// "Found N matches..." or "No files found"
			const matchCount = rawResult.match(/^Found (\d+) match/);
			if (matchCount) return `${matchCount[1]} match${matchCount[1] === '1' ? '' : 'es'}`;
			if (rawResult.startsWith('No files found')) return 'No matches';
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult;
		}

		case 'file_glob': {
			if (rawResult.startsWith('No files found')) return 'No files found';
			const files = rawResult.split('\n').filter((l) => l && !l.startsWith('('));
			return `${files.length} file${files.length === 1 ? '' : 's'}`;
		}

		case 'file_list': {
			const entries = rawResult.split('\n').filter(Boolean);
			return `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
		}

		case 'files_list': {
			// files_list returns newline-separated file paths (plain text, not JSON)
			const files = rawResult.split('\n').filter(Boolean);
			return `${files.length} file${files.length === 1 ? '' : 's'}`;
		}

		case 'docs_search': {
			return 'Results fetched';
		}

		case 'web_fetch': {
			// Output is the summarized markdown text (plain text, not JSON)
			return `${rawResult.length} chars`;
		}

		case 'user_question': {
			// Output is "Question for the user: <question>\n..."
			const questionMatch = rawResult.match(/^Question for the user: (.+)/);
			if (questionMatch) {
				const q = questionMatch[1];
				return q.length > 60 ? q.slice(0, 60) + '...' : q;
			}
			return 'Question';
		}

		default: {
			// Exhaustive check: if a new ToolName is added without a case above,
			// TypeScript will error here because `toolName` won't be assignable to `never`.
			const _exhaustiveCheck: never = toolName;
			return String(_exhaustiveCheck);
		}
	}
}

interface TodoItemDisplay {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
}

function TodoStatusIcon({ status }: { status: TodoItemDisplay['status'] }) {
	switch (status) {
		case 'completed': {
			return <CheckCircle2 className="size-3.5 text-success" />;
		}
		case 'in_progress': {
			return <PlayCircle className="size-3.5 text-accent" />;
		}
		default: {
			return <Circle className="size-3.5 text-text-secondary" />;
		}
	}
}

const PRIORITY_PILL_COLOR: Record<TodoItemDisplay['priority'], NonNullable<PillProperties['color']>> = {
	high: 'error',
	medium: 'warning',
	low: 'muted',
};

function InlineTodoList({ todos }: { todos: TodoItemDisplay[] }) {
	return (
		<div
			className="
				animate-chat-item rounded-lg border border-border bg-bg-secondary p-2
			"
		>
			<div
				className="
					mb-1.5 flex items-center gap-1.5 text-2xs font-semibold tracking-wider
					text-text-secondary uppercase
				"
			>
				<ListTodo className="size-3.5" />
				TODOs
			</div>
			<div className="flex flex-col gap-1">
				{todos.map((item) => (
					<div
						key={item.id}
						className="
							flex items-start gap-2 rounded-md bg-bg-primary px-2.5 py-1.5 text-xs
						"
					>
						<span className="mt-0.5 shrink-0">
							<TodoStatusIcon status={item.status} />
						</span>
						<span className={cn('flex-1 text-text-primary', item.status === 'completed' && 'text-text-secondary line-through')}>
							{item.content}
						</span>
						<Pill color={PRIORITY_PILL_COLOR[item.priority]} className="shrink-0">
							{item.priority}
						</Pill>
					</div>
				))}
			</div>
		</div>
	);
}

/**
 * Try to extract a TODO list from a tool result JSON string.
 */
function extractTodosFromResult(toolName: ToolName, rawResult: string): TodoItemDisplay[] | undefined {
	if (toolName !== 'todos_get' && toolName !== 'todos_update') return undefined;
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (!isRecord(parsed) || !Array.isArray(parsed.todos)) return undefined;
		const todos: unknown[] = parsed.todos;
		if (todos.length === 0) return undefined;
		return todos.filter(
			(item): item is TodoItemDisplay =>
				isRecord(item) &&
				typeof item.id === 'string' &&
				typeof item.content === 'string' &&
				typeof item.status === 'string' &&
				typeof item.priority === 'string',
		);
	} catch {
		return undefined;
	}
}

/**
 * Extract the `result` string from a structured tool result JSON.
 * Tools like file_edit, file_write, lint_fix, plan_update, file_move, file_delete
 * return `{ result: "...", ... }`. This extracts the human-readable `result` field.
 */
function extractResultField(rawResult: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (isRecord(parsed) && typeof parsed.result === 'string') {
			return parsed.result;
		}
	} catch {
		// Not JSON
	}
	return undefined;
}

/**
 * Format raw tool result content for the expandable detail view.
 * Strips XML tags and formats per-tool content cleanly.
 */
function formatToolResultDetail(toolName: ToolName, rawResult: string): string {
	// Errors are plain text — return as-is
	if (isErrorResult(rawResult)) {
		return rawResult;
	}

	switch (toolName) {
		case 'file_read': {
			// Show just the file content or directory entries, without XML wrapper
			const content = extractTag(rawResult, 'content');
			if (content) return content;
			const entries = extractTag(rawResult, 'entries');
			if (entries) return entries;
			return rawResult;
		}

		case 'file_edit':
		case 'file_multiedit':
		case 'file_write':
		case 'lint_fix': {
			// These tools return { result: "diff...", linesAdded, ... }
			// Show the diff/result text (fallback for when InlineDiffView is unavailable, e.g. page reload)
			return extractResultField(rawResult) ?? rawResult;
		}

		case 'file_delete':
		case 'file_move':
		case 'plan_update': {
			// These tools return { result: "summary..." }
			return extractResultField(rawResult) ?? rawResult;
		}

		case 'file_grep':
		case 'file_glob': {
			// Already plain text, show as-is
			return rawResult;
		}

		case 'file_list': {
			// JSON with { path, entries: [...] } — format as a clean directory listing
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && Array.isArray(parsed.entries)) {
					return parsed.entries
						.filter((entry): entry is Record<string, unknown> => isRecord(entry))
						.map((entry) => {
							const name = typeof entry.name === 'string' ? entry.name : '';
							const suffix = entry.type === 'directory' ? '/' : '';
							const size = typeof entry.size === 'number' ? `  (${entry.size} bytes)` : '';
							return `${name}${suffix}${size}`;
						})
						.join('\n');
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'files_list': {
			// JSON with { files: [...] } — format as a file list
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && Array.isArray(parsed.files)) {
					return parsed.files.filter((file): file is string => typeof file === 'string').join('\n');
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'dependencies_list': {
			// JSON with { dependencies: { name: version } }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && isRecord(parsed.dependencies)) {
					const entries = Object.entries(parsed.dependencies);
					if (entries.length === 0) {
						return typeof parsed.note === 'string' ? parsed.note : 'No dependencies';
					}
					return entries.map(([name, version]) => `${name}: ${String(version)}`).join('\n');
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'dependencies_update': {
			// JSON with { success, action, name, dependencies }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.action === 'string' && typeof parsed.name === 'string') {
					const verb = parsed.action === 'add' ? 'Added' : parsed.action === 'remove' ? 'Removed' : 'Updated';
					let summary = `${verb} ${parsed.name}`;
					if (isRecord(parsed.dependencies)) {
						const version = parsed.dependencies[parsed.name];
						if (typeof version === 'string') summary += `@${version}`;
					}
					return summary;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'web_fetch': {
			// JSON with { url, content, length }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.content === 'string') {
					const url = typeof parsed.url === 'string' ? `Source: ${parsed.url}\n\n` : '';
					return `${url}${parsed.content}`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'docs_search': {
			// JSON with { results: ... }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed)) {
					return JSON.stringify(parsed, undefined, 2);
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'cdp_eval': {
			// JSON with { method, result: ... }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed)) {
					const method = typeof parsed.method === 'string' ? `Method: ${parsed.method}\n\n` : '';
					const result = parsed.result === undefined ? 'No result' : JSON.stringify(parsed.result, undefined, 2);
					return `${method}${result}`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'user_question': {
			// JSON with { question, options, message }
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.question === 'string') {
					return parsed.question;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		case 'todos_get':
		case 'todos_update': {
			// Handled by InlineTodoList — just return a summary
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && Array.isArray(parsed.todos)) {
					const completed = parsed.todos.filter((t): t is Record<string, unknown> => isRecord(t) && t.status === 'completed').length;
					return `${completed}/${parsed.todos.length} tasks completed`;
				}
			} catch {
				// Not JSON
			}
			return rawResult;
		}

		default: {
			// Try JSON pretty-print, fall back to raw
			try {
				const parsed: unknown = JSON.parse(rawResult);
				return JSON.stringify(parsed, undefined, 2);
			} catch {
				return rawResult;
			}
		}
	}
}

/**
 * Build the detail text shown in the expandable dropdown.
 * Combines raw result content with structured error info when available.
 */
function getExpandableDetailText(
	toolName: ToolName,
	rawResultContent: string | undefined,
	structuredError: ToolErrorInfo | undefined,
): string {
	const parts: string[] = [];
	if (structuredError) {
		const prefix = structuredError.errorCode ? `[${structuredError.errorCode}] ` : '';
		parts.push(`${prefix}${structuredError.errorMessage}`);
	}
	if (rawResultContent) {
		const formatted = formatToolResultDetail(toolName, rawResultContent);
		// Avoid duplicating the error message if it's the same as the structured error
		if (!structuredError || formatted !== parts[0]) {
			parts.push(formatted);
		}
	}
	return parts.join('\n\n');
}

/**
 * Unwrap a tool result from its `{ content: string }` envelope.
 *
 * Server tools return `{ content: text }` objects so that `@tanstack/ai`'s
 * `executeToolCalls()` doesn't `JSON.parse` a plain string.  The result
 * arrives on the client as:
 *   - `ToolResultPart.content`: JSON string `'{"content":"..."}'`
 *   - `ToolCallPart.output`: parsed object `{ content: "..." }`
 */
function unwrapToolContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed) && typeof parsed.content === 'string') {
				return parsed.content;
			}
			// TanStack AI wraps tool execution errors as {"error":"..."}
			if (isRecord(parsed) && typeof parsed.error === 'string') {
				return parsed.error;
			}
		} catch {
			// Not JSON
		}
		return value || undefined;
	}
	if (isRecord(value) && typeof value.content === 'string') {
		return value.content;
	}
	if (isRecord(value) && typeof value.error === 'string') {
		return value.error;
	}
	return value === undefined ? undefined : JSON.stringify(value);
}

/**
 * Get the raw result string from a ToolCallPart and/or ToolResultPart.
 * TanStack AI puts the result in ToolResultPart.content (string) or ToolCallPart.output.
 */
function getToolResultContent(toolCall: ToolCallPart, toolResult?: ToolResultPart): string | undefined {
	if (toolResult && typeof toolResult.content === 'string' && toolResult.content) {
		return unwrapToolContent(toolResult.content);
	}
	if (toolCall.output !== undefined) {
		return unwrapToolContent(toolCall.output);
	}
	return undefined;
}

/**
 * Check if a tool call has an error result.
 */
function isToolError(toolCall: ToolCallPart, toolResult?: ToolResultPart): boolean {
	if (toolResult?.state === 'error') return true;
	if (toolResult?.error) return true;
	const content = getToolResultContent(toolCall, toolResult);
	return content !== undefined && isErrorResult(content);
}

/**
 * Render a compact unified diff view from before/after content.
 * Shows added lines in green, removed lines in red, with line numbers.
 */
function InlineDiffView({ beforeContent, afterContent }: { beforeContent: string; afterContent: string }) {
	const hunks = useMemo(() => computeDiffHunks(beforeContent, afterContent), [beforeContent, afterContent]);

	if (hunks.length === 0) return;

	// Build rendered lines from hunks with a few lines of surrounding context.
	// We re-derive context from the afterContent so the diff is self-contained.
	const afterLines = afterContent.split('\n');

	// Build a set of "after" line numbers that are part of added hunks (1-indexed)
	const addedLineSet = new Set<number>();
	for (const hunk of hunks) {
		if (hunk.type === 'added') {
			for (let index = 0; index < hunk.lineCount; index++) {
				addedLineSet.add(hunk.startLine + index);
			}
		}
	}

	// Build diff display lines: show hunks with up to 2 lines of context
	const CONTEXT = 2;
	interface DiffLine {
		type: 'added' | 'removed' | 'context';
		content: string;
	}
	const diffLines: DiffLine[] = [];
	let lastRenderedAfterLine = 0;

	for (const hunk of hunks) {
		if (hunk.type === 'removed') {
			// Show context lines before this removed block
			const contextStart = Math.max(lastRenderedAfterLine + 1, hunk.startLine - CONTEXT);
			if (contextStart > lastRenderedAfterLine + 1 && diffLines.length > 0) {
				diffLines.push({ type: 'context', content: '···' });
			}
			for (let index = contextStart; index < hunk.startLine; index++) {
				if (!addedLineSet.has(index)) {
					diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
					lastRenderedAfterLine = index;
				}
			}
			// Render removed lines
			for (const line of hunk.lines) {
				diffLines.push({ type: 'removed', content: line });
			}
		} else {
			// Added hunk
			const contextStart = Math.max(lastRenderedAfterLine + 1, hunk.startLine - CONTEXT);
			if (contextStart > lastRenderedAfterLine + 1 && diffLines.length > 0) {
				diffLines.push({ type: 'context', content: '···' });
			}
			for (let index = contextStart; index < hunk.startLine; index++) {
				if (!addedLineSet.has(index)) {
					diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
					lastRenderedAfterLine = index;
				}
			}
			// Render added lines
			for (const line of hunk.lines) {
				diffLines.push({ type: 'added', content: line });
			}
			lastRenderedAfterLine = hunk.startLine + hunk.lineCount - 1;
		}
	}

	// Trailing context after last hunk
	const trailingStart = lastRenderedAfterLine + 1;
	const trailingEnd = Math.min(afterLines.length, lastRenderedAfterLine + CONTEXT);
	for (let index = trailingStart; index <= trailingEnd; index++) {
		if (!addedLineSet.has(index)) {
			diffLines.push({ type: 'context', content: afterLines[index - 1] ?? '' });
		}
	}

	return (
		<div
			className="
				max-h-60 overflow-auto rounded-md bg-bg-primary font-mono text-2xs/relaxed
			"
		>
			{diffLines.map((line, index) => (
				<div
					key={index}
					className={cn(
						'px-2.5 whitespace-pre-wrap',
						line.type === 'added' && 'bg-success/10 text-success',
						line.type === 'removed' && 'bg-error/10 text-error',
						line.type === 'context' && 'text-text-secondary',
					)}
				>
					<span className="mr-2 inline-block w-4 text-right opacity-50 select-none">
						{line.type === 'added' ? '+' : line.type === 'removed' ? '-' : ' '}
					</span>
					{line.content || '\u00A0'}
				</div>
			))}
		</div>
	);
}

/**
 * Display a list of lint diagnostics in the tool call expanded view.
 */
function InlineDiagnosticsList({ diagnostics }: { diagnostics: unknown[] }) {
	return (
		<div
			className="
				max-h-40 overflow-auto rounded-md bg-bg-primary p-2 text-2xs/relaxed
			"
		>
			{diagnostics.map((diagnostic, index) => {
				if (!isRecord(diagnostic)) return;
				const line = typeof diagnostic.line === 'number' ? diagnostic.line : '?';
				const column = typeof diagnostic.column === 'number' ? diagnostic.column : '?';
				const severity = diagnostic.severity === 'error' ? 'error' : 'warning';
				const rule = typeof diagnostic.rule === 'string' ? diagnostic.rule : '';
				const message = typeof diagnostic.message === 'string' ? diagnostic.message : '';
				const fixable = diagnostic.fixable === true;

				return (
					<div key={index} className="flex items-start gap-2 py-0.5">
						<span className={cn('shrink-0 font-mono', severity === 'error' ? 'text-error' : 'text-warning')}>
							{line}:{column}
						</span>
						<span className="min-w-0 flex-1 text-text-secondary">
							{message}
							{rule && <span className="ml-1.5 text-text-secondary/60">({rule})</span>}
						</span>
						{fixable && (
							<Pill color="muted" size="xs" className="shrink-0">
								fixable
							</Pill>
						)}
					</div>
				);
			})}
		</div>
	);
}

function InlineToolCall({
	toolCall,
	toolResult,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	isExpanded,
	onToggleExpand,
}: {
	toolCall: ToolCallPart;
	toolResult?: ToolResultPart;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	isExpanded: boolean;
	onToggleExpand: () => void;
}) {
	const knownToolName: ToolName | undefined = isToolName(toolCall.name) ? toolCall.name : undefined;
	const displayToolName = toolCall.name || 'unknown';
	const isCompleted = toolCall.state === 'input-complete' && (toolResult !== undefined || toolCall.output !== undefined);
	const rawResultContent = getToolResultContent(toolCall, toolResult);
	const isUnknownTool = knownToolName === undefined;

	// Structured metadata from CUSTOM tool_result events (populated during streaming).
	const structuredMetadata = toolMetadata?.get(toolCall.id);
	const metadata = structuredMetadata?.metadata;

	// Structured error data from CUSTOM tool_error events (populated during streaming).
	// Also check tool result content via regex as a fallback for loaded sessions where
	// the toolErrors ref is empty.
	const structuredError = toolErrors?.get(toolCall.id);
	const isError = isUnknownTool || structuredError !== undefined || isToolError(toolCall, toolResult);

	// Extract file paths from tool input.
	// Prefer toolCall.input (parsed object), fall back to parsing toolCall.arguments (JSON string).
	const input = isRecord(toolCall.input)
		? toolCall.input
		: (() => {
				try {
					const parsed: unknown = JSON.parse(toolCall.arguments);
					return isRecord(parsed) ? parsed : {};
				} catch {
					return {};
				}
			})();
	let singlePath: string | undefined;
	let fromPath: string | undefined;
	let toPath: string | undefined;
	let pattern: string | undefined;
	let extraLabel: string | undefined;
	if (typeof input.path === 'string') {
		singlePath = input.path;
	} else if (typeof input.from_path === 'string' && typeof input.to_path === 'string') {
		fromPath = input.from_path;
		toPath = input.to_path;
	}
	if (typeof input.pattern === 'string') {
		pattern = input.pattern;
	}
	if (typeof input.url === 'string') {
		extraLabel = input.url;
	}
	if (typeof input.query === 'string') {
		extraLabel = input.query;
	}

	// Extract TODOs — prefer structured metadata, fall back to parsing raw result
	const metadataTodos =
		metadata && Array.isArray(metadata.todos)
			? metadata.todos.filter(
					(item): item is TodoItemDisplay =>
						isRecord(item) &&
						typeof item.id === 'string' &&
						typeof item.content === 'string' &&
						typeof item.status === 'string' &&
						typeof item.priority === 'string',
				)
			: undefined;
	const todos = metadataTodos ?? (knownToolName && rawResultContent ? extractTodosFromResult(knownToolName, rawResultContent) : undefined);

	// Extract file-edit stats from structured metadata (file_edit, file_write, lint_fix).
	// Falls back to parsing the raw JSON result for loaded sessions without metadata.
	const linesAdded = typeof metadata?.linesAdded === 'number' ? metadata.linesAdded : undefined;
	const linesRemoved = typeof metadata?.linesRemoved === 'number' ? metadata.linesRemoved : undefined;
	const lintErrorCount =
		typeof metadata?.diagnostics === 'object' && Array.isArray(metadata.diagnostics) ? metadata.diagnostics.length : undefined;
	const editStats =
		linesAdded === undefined
			? isCompleted && rawResultContent
				? parseFileEditResult(rawResultContent)
				: undefined
			: { linesAdded, linesRemoved: linesRemoved ?? 0, lintErrorCount: lintErrorCount ?? 0, result: '' };
	const hasEditStats = editStats !== undefined && (editStats.linesAdded > 0 || editStats.linesRemoved > 0 || editStats.lintErrorCount > 0);

	// Build summary text for the result.
	// Prefer structured metadata title, then structured error, then raw parsing fallback.
	const resultSummary = isUnknownTool
		? `Unknown tool: ${displayToolName}`
		: structuredError
			? shortenErrorFromStructured(structuredError)
			: hasEditStats
				? undefined
				: structuredMetadata
					? summarizeFromMetadata(knownToolName, structuredMetadata)
					: rawResultContent && knownToolName
						? summarizeToolResult(knownToolName, rawResultContent)
						: isCompleted
							? 'No result'
							: undefined;

	// Diagnostics from metadata for expanded view
	const diagnostics = metadata && Array.isArray(metadata.diagnostics) ? metadata.diagnostics : undefined;

	// Diff content from the file_changed CUSTOM event (carries beforeContent/afterContent)
	const diffContent = fileDiffContent?.get(toolCall.id);
	const hasDiffContent = diffContent !== undefined;

	// Every completed tool call with content or a structured error is expandable.
	// File-editing tools with before/after content are also expandable (for the diff view).
	const hasDetailContent = rawResultContent !== undefined || structuredError !== undefined || hasDiffContent;
	const expandable = !isUnknownTool && isCompleted && hasDetailContent;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1.5">
			<button
				type="button"
				onClick={() => expandable && onToggleExpand()}
				className={cn(
					`
						flex flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-md
						px-3 py-1.5 text-xs
					`,
					isCompleted && !isError && 'bg-success/5 text-text-secondary',
					isError && 'bg-error/5 text-error',
					!isCompleted && 'bg-bg-tertiary text-text-secondary',
					expandable &&
						`
							cursor-pointer transition-colors
							hover:bg-bg-tertiary
						`,
				)}
			>
				{expandable && <ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />}
				<span className={cn('shrink-0', isCompleted && !isError && 'text-success', isError && 'text-error')}>
					{knownToolName ? <ToolIcon name={knownToolName} /> : <AlertCircle className="size-3" />}
				</span>
				<span className="shrink-0 font-medium capitalize">{displayToolName.replaceAll('_', ' ')}</span>
				{singlePath && <FileReference path={singlePath} className="max-w-48 truncate" interactive={false} />}
				{fromPath && toPath && (
					<span className="flex max-w-48 items-center gap-1">
						<FileReference path={fromPath} className="truncate" interactive={false} />
						<span className="shrink-0 text-text-secondary">→</span>
						<FileReference path={toPath} className="truncate" interactive={false} />
					</span>
				)}
				{pattern && (
					<span className="max-w-48 truncate font-mono text-text-secondary" title={pattern}>
						{pattern}
					</span>
				)}
				{!singlePath && !fromPath && !pattern && extraLabel && (
					<span className="max-w-48 truncate text-text-secondary" title={extraLabel}>
						{extraLabel.length > 60 ? extraLabel.slice(0, 60) + '...' : extraLabel}
					</span>
				)}
				{resultSummary && <span className="ml-auto min-w-0 truncate text-text-secondary">{resultSummary}</span>}
				{/* File edit stats: lines added, removed, lint errors */}
				{hasEditStats && editStats && (
					<span className={cn('flex shrink-0 items-center gap-1.5', !resultSummary && 'ml-auto')}>
						{editStats.linesAdded > 0 && (
							<span className="font-mono text-success" title={`${editStats.linesAdded} line${editStats.linesAdded === 1 ? '' : 's'} added`}>
								+{editStats.linesAdded}
							</span>
						)}
						{editStats.linesRemoved > 0 && (
							<span
								className="font-mono text-error"
								title={`${editStats.linesRemoved} line${editStats.linesRemoved === 1 ? '' : 's'} removed`}
							>
								-{editStats.linesRemoved}
							</span>
						)}
						{editStats.lintErrorCount > 0 && (
							<span
								className="font-mono text-warning"
								title={`${editStats.lintErrorCount} lint error${editStats.lintErrorCount === 1 ? '' : 's'}`}
							>
								⚠ {editStats.lintErrorCount}
							</span>
						)}
					</span>
				)}
			</button>
			{isExpanded &&
				hasDetailContent &&
				(hasDiffContent ? (
					<InlineDiffView beforeContent={diffContent.beforeContent} afterContent={diffContent.afterContent} />
				) : (
					<pre
						className="
							max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
							text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
						"
					>
						{knownToolName ? getExpandableDetailText(knownToolName, rawResultContent, structuredError) : rawResultContent}
					</pre>
				))}
			{isExpanded && diagnostics && diagnostics.length > 0 && <InlineDiagnosticsList diagnostics={diagnostics} />}
			{todos && todos.length > 0 && <InlineTodoList todos={todos} />}
		</div>
	);
}

// =============================================================================
// User Question Prompt
// =============================================================================

export function UserQuestionPrompt({
	question,
	options,
	onOptionClick,
}: {
	question: string;
	options: string;
	onOptionClick: (option: string) => void;
}) {
	const parsedOptions = options
		? options
				.split(',')
				.map((option) => option.trim())
				.filter(Boolean)
		: [];

	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-accent/25
				bg-accent/5 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-accent">
				<HelpCircle className="size-4" />
				<span>Question</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{question}</div>
			{parsedOptions.length > 0 && (
				<div className="flex flex-wrap gap-2">
					{parsedOptions.map((option) => (
						<button
							key={option}
							onClick={() => onOptionClick(option)}
							className={cn(
								`
									inline-flex cursor-pointer items-center rounded-md border border-border
									bg-bg-tertiary
								`,
								'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
								'hover:border-accent hover:text-text-primary',
							)}
						>
							{option}
						</button>
					))}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// Continuation Prompt
// =============================================================================

export function ContinuationPrompt({ onContinue, onDismiss }: { onContinue: () => void; onDismiss: () => void }) {
	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-accent/25
				bg-accent/5 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-accent">
				<FastForward className="size-4 shrink-0" />
				<span className="truncate">Iteration Limit Reached</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">
				The AI has reached the maximum number of tool iterations. You can continue where it left off or start a new prompt.
			</div>
			<div className="flex flex-wrap gap-2">
				<button
					onClick={onContinue}
					className={cn(
						`
							inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3
							py-1.5
						`,
						'text-xs font-medium text-white transition-colors',
						'hover:bg-accent-hover',
					)}
				>
					<FastForward className="size-3" />
					Continue
				</button>
				<button
					onClick={onDismiss}
					className={cn(
						`
							inline-flex cursor-pointer items-center rounded-md border border-border
							bg-bg-tertiary
						`,
						'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
						'hover:bg-border hover:text-text-primary',
					)}
				>
					Dismiss
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// Doom Loop Alert
// =============================================================================

export function DoomLoopAlert({ message, onRetry, onDismiss }: { message: string; onRetry: () => void; onDismiss: () => void }) {
	return (
		<div
			className="
				flex animate-chat-item flex-col gap-2.5 rounded-lg border border-warning/25
				bg-warning/10 p-3
			"
		>
			<div className="flex items-center gap-2 text-xs font-semibold text-warning">
				<RefreshCw className="size-4 shrink-0" />
				<span className="truncate">Loop Detected</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex flex-wrap gap-2">
				<button
					onClick={onRetry}
					className={cn(
						`
							inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent px-3
							py-1.5
						`,
						'text-xs font-medium text-white transition-colors',
						'hover:bg-accent-hover',
					)}
				>
					<RefreshCw className="size-3" />
					Retry
				</button>
				<button
					onClick={onDismiss}
					className={cn(
						`
							inline-flex cursor-pointer items-center rounded-md border border-border
							bg-bg-tertiary
						`,
						'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
						'hover:bg-border hover:text-text-primary',
					)}
				>
					Dismiss
				</button>
			</div>
		</div>
	);
}

// =============================================================================
// AI Error Component
// =============================================================================

export function AIError({
	message,
	code,
	onRetry,
	onDismiss,
}: {
	message: string;
	code?: string;
	onRetry?: () => void;
	onDismiss?: () => void;
}) {
	const isRateLimit = code === 'RATE_LIMIT' || code === 'RATE_LIMIT_EXCEEDED' || code === 'OVERLOADED';
	const isRetryable = code !== 'AUTH_ERROR' && code !== 'INVALID_REQUEST';

	return (
		<div
			className={cn(
				'flex animate-chat-item flex-col gap-2.5 rounded-lg border p-3',
				isRateLimit ? 'border-warning/25 bg-warning/10' : 'border-error/25 bg-error/10',
			)}
		>
			<div className={cn('flex items-center gap-2 text-xs font-semibold', isRateLimit ? 'text-warning' : 'text-error')}>
				{isRateLimit ? <Clock className="size-4 shrink-0" /> : <AlertCircle className="size-4 shrink-0" />}
				<span className="truncate">{isRateLimit ? 'Rate Limit Exceeded' : 'Error'}</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex flex-wrap gap-2">
				{isRetryable && onRetry && (
					<button
						onClick={onRetry}
						className={cn(
							`
								inline-flex cursor-pointer items-center gap-1.5 rounded-md bg-accent
								px-3 py-1.5
							`,
							`
								text-xs font-medium text-white transition-colors
								hover:bg-accent-hover
							`,
						)}
					>
						<RefreshCw className="size-3" />
						Retry
					</button>
				)}
				{onDismiss && (
					<button
						onClick={onDismiss}
						className={cn(
							`
								inline-flex cursor-pointer items-center rounded-md border border-border
								bg-bg-tertiary
							`,
							'px-3 py-1.5 text-xs font-medium text-text-secondary transition-colors',
							'hover:bg-border hover:text-text-primary',
						)}
					>
						Dismiss
					</button>
				)}
			</div>
		</div>
	);
}
