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
import { useEffect, useMemo, useRef, useState } from 'react';

import { Pill, type PillProperties } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { TOOL_ERROR_LABELS } from '@shared/tool-errors';

import { AI_SUGGESTIONS, isRecord, isToolName } from './helpers';
import { parseTextToSegments } from '../../lib/input-segments';
import { FileReference } from '../file-reference';
import { MarkdownContent } from '../markdown-content';

import type { AgentMode, ToolErrorInfo, UIMessage } from '@shared/types';
import type { ToolName } from '@shared/validation';

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
		case 'file_write':
		case 'file_patch': {
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
	onRevert,
	toolErrors,
}: {
	message: UIMessage;
	messageIndex: number;
	snapshotId?: string;
	isReverting: boolean;
	onRevert: (snapshotId: string, messageIndex: number) => void;
	toolErrors?: Map<string, ToolErrorInfo>;
}) {
	if (message.role === 'user') {
		return (
			<UserMessage message={message} messageIndex={messageIndex} snapshotId={snapshotId} isReverting={isReverting} onRevert={onRevert} />
		);
	}

	return <AssistantMessage message={message} toolErrors={toolErrors} />;
}

// =============================================================================
// User Message
// =============================================================================

function UserMessage({
	message,
	messageIndex,
	snapshotId,
	isReverting,
	onRevert,
}: {
	message: UIMessage;
	messageIndex: number;
	snapshotId?: string;
	isReverting: boolean;
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
							{isReverting ? <Loader2 className="size-3 animate-spin" /> : <RotateCcw className="size-3" />}
							Revert
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
	| { kind: 'text'; text: string }
	| { kind: 'thinking'; text: string }
	| { kind: 'tool'; toolCall: ToolCallPart; toolResult?: ToolResultPart };

/**
 * Regex matching XML-like tool call tags that models sometimes emit
 * inside thinking or text content. These are noise and should be stripped.
 *
 * Matches:
 * - `<function_calls>...</function_calls>` (with any content inside, including JSON)
 * - `<invoke ...>...</invoke>` / `<invoke ...>...</invoke>`
 * - `<tool_use>...</tool_use>` / `<tool_call>...</tool_call>`
 * - Unclosed variants (partial streaming) that run to end of string
 */
const XML_TOOL_CALL_PATTERN =
	/<(?:function_calls|antml:function_calls|invoke\s|antml:invoke|tool_use|tool_call)[^>]*>[\s\S]*?(?:<\/(?:function_calls|antml:function_calls|invoke|antml:invoke|tool_use|tool_call)>|$)/g;

/**
 * Strip XML-like partial tool call fragments from text.
 * Returns the cleaned text, or an empty string if nothing remains.
 */
function stripPartialToolCalls(text: string): string {
	return text.replaceAll(XML_TOOL_CALL_PATTERN, '').trim();
}

/** Check whether text contains tool call XML fragments. */
function containsToolCallXml(text: string): boolean {
	// Reset lastIndex since the regex is global
	XML_TOOL_CALL_PATTERN.lastIndex = 0;
	return XML_TOOL_CALL_PATTERN.test(text);
}

function buildRenderSegments(parts: unknown[]): RenderSegment[] {
	const segments: RenderSegment[] = [];

	// Collect tool results into a lookup so we can pair them with tool calls
	const resultsByCallId = new Map<string, ToolResultPart>();
	for (const part of parts) {
		if (isToolResultPart(part)) {
			resultsByCallId.set(part.toolCallId, part);
		}
	}

	for (const part of parts) {
		if (isTextPart(part)) {
			const raw = part.content.trim();
			if (!raw) continue;
			// Strip tool call XML that models sometimes emit in text parts
			const hadXml = containsToolCallXml(raw);
			const trimmed = hadXml ? stripPartialToolCalls(raw) : raw;
			if (!trimmed) continue;
			// If the text originally contained tool call XML, the remaining
			// content is the model narrating its tool use — render it as a
			// collapsible thinking segment instead of visible text.
			if (hadXml) {
				segments.push({ kind: 'thinking', text: trimmed });
			} else {
				// Merge consecutive text segments
				const last = segments.at(-1);
				if (last?.kind === 'text') {
					last.text += '\n' + trimmed;
				} else {
					segments.push({ kind: 'text', text: trimmed });
				}
			}
		} else if (isThinkingPart(part)) {
			const cleaned = stripPartialToolCalls(part.content);
			if (!cleaned) continue;
			segments.push({ kind: 'thinking', text: cleaned });
		} else if (isToolCallPart(part)) {
			const result = resultsByCallId.get(part.id);
			segments.push({ kind: 'tool', toolCall: part, toolResult: result });
		}
		// tool-result parts are consumed via the lookup above
	}
	return segments;
}

export function AssistantMessage({
	message,
	streaming,
	toolErrors,
}: {
	message: UIMessage;
	streaming?: boolean;
	toolErrors?: Map<string, ToolErrorInfo>;
}) {
	const segments = buildRenderSegments(message.parts);
	const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
	const scrollReference = useRef<HTMLDivElement>(null);

	const hasToolCalls = segments.some((segment) => segment.kind === 'tool');
	const lastTextIndex = segments.findLastIndex((segment) => segment.kind === 'text');

	// Auto-scroll the active streaming thinking box
	useEffect(() => {
		if (streaming && scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [streaming, message.parts]);

	const toggleThinking = (index: number) => {
		setExpandedThinking((previous) => {
			const next = new Set(previous);
			if (next.has(index)) {
				next.delete(index);
			} else {
				next.add(index);
			}
			return next;
		});
	};

	// Simple Q&A mode: no tool calls and not streaming — render text normally
	if (!hasToolCalls && !streaming) {
		return (
			<div className="flex min-w-0 animate-chat-item flex-col gap-2">
				<div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>
				{segments.map((segment, index) => {
					if (segment.kind === 'text') {
						return (
							<div
								key={index}
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
						const isExpanded = expandedThinking.has(index);
						return (
							<div key={index} className="flex flex-col gap-1.5">
								<button
									type="button"
									onClick={() => toggleThinking(index)}
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
					return <InlineToolCall key={index} toolCall={segment.toolCall} toolResult={segment.toolResult} toolErrors={toolErrors} />;
				}

				// Thinking segments — collapsible
				if (segment.kind === 'thinking') {
					const isExpanded = expandedThinking.has(index);
					return (
						<div key={index} className="flex flex-col gap-1.5">
							<button
								type="button"
								onClick={() => toggleThinking(index)}
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
							key={index}
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
							key={index}
							ref={scrollReference}
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

				// Earlier text segments: render as normal text blocks
				return (
					<div
						key={index}
						className="
							overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
							text-text-primary
						"
					>
						<MarkdownContent content={segment.text} />
					</div>
				);
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
 * Parse a tool result string into a brief human-readable summary.
 * Each tool gets a custom parser; falls back to a cleaned-up truncation.
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
			// Show actual result — don't blindly say "Applied" if the edit may have failed silently
			if (rawResult.includes('Edit applied successfully')) return 'Applied';
			if (rawResult.includes('No changes needed')) return 'No changes';
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult || 'Applied';
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

		case 'file_patch': {
			// "Success. Updated the following files:\nA /path\nM /path\nD /path"
			const lines = rawResult.split('\n').filter(Boolean);
			const fileCount = lines.filter((l) => /^[AMD] /.test(l)).length;
			if (fileCount > 0) return `${fileCount} file${fileCount === 1 ? '' : 's'} changed`;
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult;
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
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && Array.isArray(parsed.files)) {
					const files: unknown[] = parsed.files;
					return `${files.length} file${files.length === 1 ? '' : 's'}`;
				}
			} catch {
				/* not JSON */
			}
			return 'Listed';
		}

		case 'docs_search': {
			return 'Results fetched';
		}

		case 'web_fetch': {
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.length === 'number') {
					return `${parsed.length} chars`;
				}
			} catch {
				/* not JSON */
			}
			return 'Fetched';
		}

		case 'user_question': {
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && typeof parsed.question === 'string') {
					return parsed.question.length > 60 ? parsed.question.slice(0, 60) + '...' : parsed.question;
				}
			} catch {
				/* not JSON */
			}
			return 'Question';
		}

		default: {
			return rawResult.length > 40 ? rawResult.slice(0, 40) + '...' : rawResult;
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

		case 'file_grep':
		case 'file_glob':
		case 'file_patch':
		case 'file_list': {
			// Already plain text, show as-is
			return rawResult;
		}

		case 'files_list':
		case 'docs_search':
		case 'web_fetch': {
			// Try to pretty-print JSON
			try {
				const parsed: unknown = JSON.parse(rawResult);
				return JSON.stringify(parsed, undefined, 2);
			} catch {
				return rawResult;
			}
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

function InlineToolCall({
	toolCall,
	toolResult,
	toolErrors,
}: {
	toolCall: ToolCallPart;
	toolResult?: ToolResultPart;
	toolErrors?: Map<string, ToolErrorInfo>;
}) {
	const [isExpanded, setIsExpanded] = useState(false);

	const knownToolName: ToolName | undefined = isToolName(toolCall.name) ? toolCall.name : undefined;
	const displayToolName = toolCall.name || 'unknown';
	const isCompleted = toolCall.state === 'input-complete' && (toolResult !== undefined || toolCall.output !== undefined);
	const rawResultContent = getToolResultContent(toolCall, toolResult);
	const isUnknownTool = knownToolName === undefined;

	// Prefer structured error data from CUSTOM tool_error events.
	// Falls back to regex-based detection for backward compatibility.
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

	// Extract TODOs from todos_get / todos_update results
	const todos = knownToolName && rawResultContent ? extractTodosFromResult(knownToolName, rawResultContent) : undefined;

	// Build summary text for the result.
	// Prefer structured error data from CUSTOM events over regex-parsing [CODE] prefixes.
	const resultSummary = isUnknownTool
		? `Unknown tool: ${displayToolName}`
		: structuredError
			? shortenErrorFromStructured(structuredError)
			: rawResultContent && knownToolName
				? summarizeToolResult(knownToolName, rawResultContent)
				: isCompleted
					? 'No result'
					: undefined;

	// Every completed tool call with content or a structured error is expandable.
	// This ensures errors (including gate rejections) always have a detail dropdown.
	const hasDetailContent = rawResultContent !== undefined || structuredError !== undefined;
	const expandable = !isUnknownTool && isCompleted && hasDetailContent;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1.5">
			<button
				type="button"
				onClick={() => expandable && setIsExpanded((previous) => !previous)}
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
			</button>
			{isExpanded && hasDetailContent && (
				<pre
					className="
						max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
						text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
					"
				>
					{knownToolName ? getExpandableDetailText(knownToolName, rawResultContent, structuredError) : rawResultContent}
				</pre>
			)}
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
				<FastForward className="size-4" />
				<span>Iteration Limit Reached</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">
				The AI has reached the maximum number of tool iterations. You can continue where it left off or start a new prompt.
			</div>
			<div className="flex gap-2">
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
				<RefreshCw className="size-4" />
				<span>Loop Detected</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex gap-2">
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
				{isRateLimit ? <Clock className="size-4" /> : <AlertCircle className="size-4" />}
				<span>{isRateLimit ? 'Rate Limit Exceeded' : 'Error'}</span>
			</div>
			<div className="text-sm/relaxed text-text-primary">{message}</div>
			<div className="flex gap-2">
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
