/**
 * AI Panel Message Sub-Components.
 * WelcomeScreen, MessageBubble, UserMessage, AssistantMessage,
 * InlineToolCall, InlineTodoList, ContinuationPrompt, AIError.
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

import { AI_SUGGESTIONS, isRecord } from './helpers';
import { parseTextToSegments } from '../../lib/input-segments';
import { FileReference } from '../file-reference';
import { MarkdownContent } from '../markdown-content';

import type { AgentContent, AgentMessage, AgentMode, ToolName } from '@shared/types';

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
				Ask me to help with your code. I can read, create, edit, and delete files in your project.
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
}: {
	message: AgentMessage;
	messageIndex: number;
	snapshotId?: string;
	isReverting: boolean;
	onRevert: (snapshotId: string, messageIndex: number) => void;
}) {
	if (message.role === 'user') {
		const textBlocks = message.content.filter((block) => block.type === 'text');
		return (
			<UserMessage content={textBlocks} messageIndex={messageIndex} snapshotId={snapshotId} isReverting={isReverting} onRevert={onRevert} />
		);
	}

	return <AssistantMessage content={message.content} />;
}

// =============================================================================
// User Message
// =============================================================================

function UserMessage({
	content,
	messageIndex,
	snapshotId,
	isReverting,
	onRevert,
}: {
	content: AgentContent[];
	messageIndex: number;
	snapshotId?: string;
	isReverting: boolean;
	onRevert: (snapshotId: string, messageIndex: number) => void;
}) {
	const text = content
		.filter((block): block is AgentContent & { type: 'text' } => block.type === 'text')
		.map((block) => block.text)
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
 * Build a list of renderable segments from content blocks, preserving order.
 * Groups adjacent text blocks, pairs tool_use with their tool_result.
 */
type RenderSegment = { kind: 'text'; text: string } | { kind: 'tool'; toolUse: AgentContent; toolResult?: AgentContent };

function buildRenderSegments(content: AgentContent[]): RenderSegment[] {
	const segments: RenderSegment[] = [];
	// Collect tool_results into a lookup so we can pair them with tool_use
	const resultsByUseId = new Map<string, AgentContent>();
	for (const block of content) {
		if (block.type === 'tool_result' && block.tool_use_id) {
			resultsByUseId.set(block.tool_use_id, block);
		}
	}

	for (const block of content) {
		if (block.type === 'text') {
			const trimmed = block.text.trim();
			if (!trimmed) continue;
			// Merge consecutive text segments
			const last = segments.at(-1);
			if (last?.kind === 'text') {
				last.text += '\n' + trimmed;
			} else {
				segments.push({ kind: 'text', text: trimmed });
			}
		} else if (block.type === 'tool_use') {
			const result = block.id ? resultsByUseId.get(block.id) : undefined;
			segments.push({ kind: 'tool', toolUse: block, toolResult: result });
		}
		// tool_result blocks are consumed via the lookup above
	}
	return segments;
}

export function AssistantMessage({ content, streaming }: { content: AgentContent[]; streaming?: boolean }) {
	const segments = buildRenderSegments(content);
	const [expandedThinking, setExpandedThinking] = useState<Set<number>>(new Set());
	const scrollReference = useRef<HTMLDivElement>(null);

	const hasToolCalls = segments.some((segment) => segment.kind === 'tool');
	const lastTextIndex = segments.findLastIndex((segment) => segment.kind === 'text');

	// Auto-scroll the active streaming thinking box
	useEffect(() => {
		if (streaming && scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [streaming, content]);

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
				{segments.map((segment, index) =>
					segment.kind === 'text' ? (
						<div
							key={index}
							className="
								overflow-hidden rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
								text-text-primary
							"
						>
							<MarkdownContent content={segment.text} />
						</div>
					) : undefined,
				)}
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
					return <InlineToolCall key={index} toolUse={segment.toolUse} toolResult={segment.toolResult} />;
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

				// Earlier text segments: collapsible thinking pill
				const isExpanded = expandedThinking.has(index);
				return (
					<div key={index} className="flex flex-col gap-1.5">
						<button
							type="button"
							onClick={() => toggleThinking(index)}
							className={cn(
								'flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs',
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
			})}
		</div>
	);
}

// =============================================================================
// Inline Tool Call
// =============================================================================

/**
 * Parse a tool result string into a brief human-readable summary.
 */
function summarizeToolResult(toolName: ToolName, rawResult: string): string {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (!isRecord(parsed)) return rawResult.slice(0, 200);

		if (toolName === 'files_list' && Array.isArray(parsed.files)) {
			const files: unknown[] = parsed.files;
			return `${files.length} file${files.length === 1 ? '' : 's'}`;
		}

		if (toolName === 'file_read' && typeof parsed.content === 'string') {
			const lineCount = parsed.content.split('\n').length;
			return `${lineCount} line${lineCount === 1 ? '' : 's'}`;
		}

		if (toolName === 'file_list' && Array.isArray(parsed.entries)) {
			const entries: unknown[] = parsed.entries;
			return `${entries.length} entr${entries.length === 1 ? 'y' : 'ies'}`;
		}

		if (toolName === 'file_glob' && Array.isArray(parsed.files)) {
			const files: unknown[] = parsed.files;
			return `${files.length} match${files.length === 1 ? '' : 'es'}`;
		}

		if (toolName === 'file_grep' && Array.isArray(parsed.results)) {
			const results: unknown[] = parsed.results;
			return `${results.length} file${results.length === 1 ? '' : 's'} matched`;
		}

		if (toolName === 'user_question' && typeof parsed.question === 'string') {
			return parsed.question.length > 60 ? parsed.question.slice(0, 60) + '…' : parsed.question;
		}

		if (toolName === 'web_fetch' && typeof parsed.length === 'number') {
			return `${parsed.length} chars`;
		}

		if (toolName === 'docs_search' && typeof parsed.results === 'string') {
			return `Results fetched`;
		}

		if (parsed.error && typeof parsed.error === 'string') {
			return parsed.error;
		}

		if (parsed.success) {
			return 'Success';
		}
	} catch {
		// Not valid JSON — return truncated raw string
	}
	return rawResult.length > 200 ? rawResult.slice(0, 200) + '...' : rawResult;
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
 * Tries to pretty-print JSON; falls back to the raw string.
 */
function formatToolResultDetail(rawResult: string): string {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		return JSON.stringify(parsed, undefined, 2);
	} catch {
		return rawResult;
	}
}

/**
 * Determine whether a tool result is large enough to warrant a
 * collapsible detail section (rather than showing everything inline).
 */
function hasExpandableDetail(toolName: ToolName, rawResult: string): boolean {
	// TODOs have their own dedicated inline widget
	if (toolName === 'todos_get' || toolName === 'todos_update') return false;
	return rawResult.length > 200;
}

function InlineToolCall({ toolUse, toolResult }: { toolUse: AgentContent; toolResult?: AgentContent }) {
	const [isExpanded, setIsExpanded] = useState(false);

	if (toolUse.type !== 'tool_use') return;

	const toolName = toolUse.name;
	const isCompleted = toolResult !== undefined;
	const isError = toolResult?.type === 'tool_result' && toolResult.is_error;

	// Extract file paths from tool input
	const input = toolUse.input;
	let singlePath: string | undefined;
	let fromPath: string | undefined;
	let toPath: string | undefined;
	let pattern: string | undefined;
	let extraLabel: string | undefined;
	if (isRecord(input)) {
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
	}

	// Extract TODOs from todos_get / todos_update results
	const todos =
		toolResult?.type === 'tool_result' && typeof toolResult.content === 'string'
			? extractTodosFromResult(toolName, toolResult.content)
			: undefined;

	// Build summary text for the result
	const rawResultContent = toolResult?.type === 'tool_result' && typeof toolResult.content === 'string' ? toolResult.content : undefined;
	const resultSummary = rawResultContent ? summarizeToolResult(toolName, rawResultContent) : undefined;
	const expandable = rawResultContent ? hasExpandableDetail(toolName, rawResultContent) : false;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1.5">
			<button
				type="button"
				onClick={() => expandable && setIsExpanded((previous) => !previous)}
				className={cn(
					'flex items-center gap-2 overflow-hidden rounded-md px-3 py-1.5 text-xs',
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
					<ToolIcon name={toolName} />
				</span>
				<span className="shrink-0 font-medium capitalize">{toolName.replaceAll('_', ' ')}</span>
				{singlePath && <FileReference path={singlePath} className="min-w-0 truncate" />}
				{fromPath && toPath && (
					<span className="flex min-w-0 items-center gap-1 truncate">
						<FileReference path={fromPath} />
						<span className="text-text-secondary">→</span>
						<FileReference path={toPath} />
					</span>
				)}
				{pattern && (
					<span className="min-w-0 truncate font-mono text-text-secondary" title={pattern}>
						{pattern}
					</span>
				)}
				{!singlePath && !fromPath && !pattern && extraLabel && (
					<span className="min-w-0 truncate text-text-secondary" title={extraLabel}>
						{extraLabel.length > 60 ? extraLabel.slice(0, 60) + '…' : extraLabel}
					</span>
				)}
				{resultSummary && <span className="ml-auto shrink-0 text-text-secondary">{resultSummary}</span>}
			</button>
			{isExpanded && rawResultContent && (
				<pre
					className="
						max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
						text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
					"
				>
					{formatToolResultDetail(rawResultContent)}
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
