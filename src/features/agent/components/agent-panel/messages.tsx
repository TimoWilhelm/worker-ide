import {
	AlertCircle,
	Bot,
	CheckCircle2,
	CheckSquare,
	ChevronRight,
	Circle,
	Clock,
	Database,
	Download,
	FastForward,
	FileText,
	FlaskConical,
	Globe,
	HelpCircle,
	Image,
	ListTodo,
	Map as MapIcon,
	PlayCircle,
	RefreshCw,
	RotateCcw,
	Settings,
	SquareTerminal,
	Terminal,
	Wrench,
	X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';

import { Button } from '@/components/ui/button';
import { Pill, type PillProperties } from '@/components/ui/pill';
import { Spinner } from '@/components/ui/spinner';
import { Tooltip } from '@/components/ui/tooltip';
import { computeDiffHunks } from '@/features/editor/lib/diff-decorations';
import { downloadDebugLog } from '@/lib/api-client';
import { fadeUpVariants, springDefault } from '@/lib/motion-config';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';
import { messagePartsToPlainText } from '@shared/chat-message-parts';
import { TOOL_ERROR_LABELS } from '@shared/tool-errors';

import { AI_SUGGESTIONS, isRecord, isToolName } from './helpers';
import { getModelLabel } from './model-config';
import { messagePartsToInputSegments } from '../../lib/input-segments';
import { FileReference } from '../file-reference';
import { MarkdownContent } from '../markdown-content';
import { PreviewElementReference } from '../preview-element-reference';

import type { SessionParticipantProfile, SubAgentActivityRecord } from '@shared/agent-state';
import type {
	AgentMode,
	ChatMessage,
	MessagePart,
	ReasoningPart,
	TextPart,
	ToolCallPart,
	ToolErrorInfo,
	ToolMetadataInfo,
	ToolResultPart,
} from '@shared/types';
import type { ToolName } from '@shared/validation';
const THINKING_BOX_BOTTOM_THRESHOLD = 16;

function isTextPart(part: MessagePart): part is TextPart {
	return part.type === 'text';
}

function isToolCallPart(part: MessagePart): part is ToolCallPart {
	return part.type === 'tool-call';
}

function isToolResultPart(part: MessagePart): part is ToolResultPart {
	return part.type === 'tool-result';
}

function isReasoningPart(part: MessagePart): part is ReasoningPart {
	return part.type === 'reasoning';
}

function ToolIcon({ name, className }: { name: ToolName; className?: string }) {
	switch (name) {
		case 'user_question': {
			return <HelpCircle className={cn('size-3', className)} />;
		}
		case 'web_fetch':
		case 'docs_search': {
			return <Globe className={cn('size-3', className)} />;
		}
		case 'browser_execute':
		case 'cdp_eval':
		case 'browser_markdown':
		case 'browser_extract':
		case 'browser_links':
		case 'browser_scrape': {
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
		case 'test_run': {
			return <FlaskConical className={cn('size-3', className)} />;
		}
		case 'asset_settings_get':
		case 'asset_settings_update': {
			return <Settings className={cn('size-3', className)} />;
		}
		case 'bindings_get':
		case 'bindings_update': {
			return <Database className={cn('size-3', className)} />;
		}
		case 'image_generate': {
			return <Image className={cn('size-3', className)} />;
		}
		case 'sub_agent': {
			return <Bot className={cn('size-3', className)} />;
		}
		case 'bash': {
			return <Terminal className={cn('size-3', className)} />;
		}
		case 'codemode': {
			return <SquareTerminal className={cn('size-3', className)} />;
		}
		default: {
			return <FileText className={cn('size-3', className)} />;
		}
	}
}

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

export function MessageBubble({
	message,
	messageIndex,
	currentUserId,
	sessionParticipants,
	agentMode,
	modelId,
	isClientOnly = false,
	canRevert = false,
	isReverting,
	revertingMessageIndex,
	onRevert,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	subAgentActivities,
	projectId,
	showHeader = true,
}: {
	message: ChatMessage;
	messageIndex: number;
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	agentMode?: AgentMode;
	modelId?: string;
	isClientOnly?: boolean;
	canRevert?: boolean;
	isReverting: boolean;
	revertingMessageIndex?: number;
	onRevert: (messageIndex: number) => void;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	/**
	 * Whether to show the "AI" header above this message.
	 * Set to false for consecutive assistant messages to group them under one header.
	 */
	showHeader?: boolean;
}) {
	if (message.role === 'user') {
		return (
			<UserMessage
				message={message}
				messageIndex={messageIndex}
				currentUserId={currentUserId}
				sessionParticipants={sessionParticipants}
				agentMode={agentMode}
				modelId={modelId}
				isClientOnly={isClientOnly}
				canRevert={canRevert}
				isReverting={isReverting}
				isRevertingThis={revertingMessageIndex === messageIndex}
				onRevert={onRevert}
			/>
		);
	}

	return (
		<AssistantMessage
			message={message}
			toolErrors={toolErrors}
			toolMetadata={toolMetadata}
			fileDiffContent={fileDiffContent}
			subAgentActivities={subAgentActivities}
			projectId={projectId}
			showHeader={showHeader}
		/>
	);
}

/**
 * Mode-specific border and background colors for user message bubbles.
 * Falls back to the default accent color when no mode is provided.
 */
const MODE_BUBBLE_STYLES: Record<AgentMode, string> = {
	code: 'border-emerald-500/25 bg-emerald-500/8',
	plan: 'border-amber-500/25 bg-amber-500/8',
	ask: 'border-sky-500/25 bg-sky-500/8',
};

const MODE_BADGE_STYLES: Record<AgentMode, { label: string; pillColor: NonNullable<PillProperties['color']> }> = {
	code: { label: 'Code', pillColor: 'emerald' },
	plan: { label: 'Plan', pillColor: 'amber' },
	ask: { label: 'Ask', pillColor: 'sky' },
};

function resolveAuthorName(
	authorUserId: string | undefined,
	currentUserId: string | undefined,
	sessionParticipants: Record<string, SessionParticipantProfile>,
): string {
	if (authorUserId && currentUserId && authorUserId === currentUserId) {
		return 'You';
	}

	if (!authorUserId) {
		return 'Unknown';
	}

	return sessionParticipants[authorUserId]?.name ?? 'Unknown';
}

function resolveAuthorColor(
	authorUserId: string | undefined,
	sessionParticipants: Record<string, SessionParticipantProfile>,
): string | undefined {
	if (!authorUserId) {
		return undefined;
	}

	return sessionParticipants[authorUserId]?.color;
}

function UserMessage({
	message,
	messageIndex,
	currentUserId,
	sessionParticipants,
	agentMode,
	modelId,
	isClientOnly,
	canRevert,
	isReverting,
	isRevertingThis,
	onRevert,
}: {
	message: ChatMessage;
	messageIndex: number;
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	agentMode?: AgentMode;
	modelId?: string;
	isClientOnly: boolean;
	canRevert: boolean;
	isReverting: boolean;
	isRevertingThis: boolean;
	onRevert: (messageIndex: number) => void;
}) {
	// Build a set of known file paths to identify file mentions
	const files = useStore((state) => state.files);
	const knownPaths = useMemo(() => new Set(files.map((file) => file.path)), [files]);
	const segments = useMemo(() => messagePartsToInputSegments(message.parts, knownPaths), [message.parts, knownPaths]);

	const bubbleStyle = agentMode ? MODE_BUBBLE_STYLES[agentMode] : 'border-accent/20 bg-accent/10';
	const badge = agentMode ? MODE_BADGE_STYLES[agentMode] : undefined;
	const modelLabel = modelId ? getModelLabel(modelId) : undefined;
	const authorName = resolveAuthorName(message.authorUserId, currentUserId, sessionParticipants);

	return (
		<motion.div
			className="flex min-w-0 flex-col gap-1"
			variants={fadeUpVariants}
			initial="hidden"
			animate="visible"
			transition={springDefault}
		>
			<div className="flex items-center justify-between">
				<div className="flex items-center gap-1.5">
					<span className="text-2xs font-semibold tracking-wider text-accent">{authorName}</span>
					{badge && (
						<Pill size="xs" color={badge.pillColor}>
							{badge.label}
						</Pill>
					)}
					{modelLabel && <Pill size="xs">{modelLabel}</Pill>}
				</div>
				{canRevert && (
					<Tooltip content="Revert the session to before this message">
						<Button
							type="button"
							variant="ghost"
							size="sm"
							onClick={() => onRevert(messageIndex)}
							disabled={isReverting}
							isLoading={isRevertingThis}
							className={cn('h-auto px-1.5 py-0.5 text-2xs font-medium text-text-secondary', 'hover:bg-warning/10 hover:text-warning')}
						>
							<RotateCcw className="size-3" />
							Revert
						</Button>
					</Tooltip>
				)}
			</div>
			<div
				className={cn('rounded-lg border px-3 py-2.5', bubbleStyle, isClientOnly && 'border-dashed', 'text-sm/relaxed text-text-primary')}
			>
				<span className="whitespace-pre-wrap">
					{segments.map((segment, index) =>
						segment.type === 'mention' ? (
							<FileReference key={index} path={segment.path} />
						) : segment.type === 'preview-element' ? (
							<PreviewElementReference key={index} reference={segment} />
						) : (
							<span key={index}>{segment.value}</span>
						),
					)}
				</span>
			</div>
		</motion.div>
	);
}

/**
 * Build a list of renderable segments from ChatMessage parts, preserving order.
 * Groups adjacent text parts, pairs tool-call with their tool-result.
 */
type RenderSegment =
	| { kind: 'text'; key: string; text: string }
	| { kind: 'thinking'; key: string; text: string }
	| { kind: 'tool'; key: string; toolCall: ToolCallPart; toolResult?: ToolResultPart };

function buildRenderSegments(parts: MessagePart[]): RenderSegment[] {
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
			const raw = (part.content ?? '').trim();
			if (!raw) continue;
			// Merge consecutive text segments
			const last = segments.at(-1);
			if (last?.kind === 'text') {
				last.text += '\n' + raw;
			} else {
				segments.push({ kind: 'text', key: `text-${textCount++}`, text: raw });
			}
		} else if (isReasoningPart(part)) {
			const cleaned = (part.content ?? '').trim();
			if (!cleaned) continue;
			segments.push({ kind: 'thinking', key: `thinking-${thinkingCount++}`, text: cleaned });
		} else if (isToolCallPart(part)) {
			const result = resultsByCallId.get(part.toolCallId);
			segments.push({ kind: 'tool', key: part.toolCallId, toolCall: part, toolResult: result });
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
	subAgentActivities,
	projectId,
	showHeader = true,
}: {
	message: ChatMessage;
	streaming?: boolean;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	showHeader?: boolean;
}) {
	const segments = buildRenderSegments(message.parts);
	const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
	const scrollReference = useRef<HTMLDivElement>(null);
	const userScrolledAwayReference = useRef(false);

	const hasToolCalls = segments.some((segment) => segment.kind === 'tool');

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

	// Don't render anything for assistant messages with no visible segments
	// (e.g. messages containing only tool-result parts with no matching tool-call).
	if (segments.length === 0 && !streaming) {
		return;
	}

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
				{showHeader && <div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>}
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

	// Interleaved thinking + tool calls + text layout
	const lastSegmentIndex = segments.length - 1;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-2">
			{showHeader && <div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>}
			{segments.map((segment, index) => {
				// ── Tool calls ───────────────────────────────────────
				if (segment.kind === 'tool') {
					return (
						<InlineToolCall
							key={segment.key}
							toolCall={segment.toolCall}
							toolResult={segment.toolResult}
							toolErrors={toolErrors}
							toolMetadata={toolMetadata}
							fileDiffContent={fileDiffContent}
							subAgentActivities={subAgentActivities}
							projectId={projectId}
							isStreaming={streaming}
							isExpanded={expandedSections.has(segment.key)}
							onToggleExpand={() => toggleSection(segment.key)}
						/>
					);
				}

				// ── Thinking segments — always height-bounded ────────
				if (segment.kind === 'thinking') {
					// A thinking segment is the "active streaming" box only when it
					// is the very last segment and we're still streaming. As soon as
					// any subsequent segment appears (text, tool, or another thinking
					// block), this one collapses into the "Show thinking" toggle.
					const isActiveStreamingThinking = streaming && index === lastSegmentIndex;

					if (isActiveStreamingThinking) {
						return (
							<div
								key={segment.key}
								ref={scrollReference}
								onScroll={handleThinkingBoxScroll}
								className="
									max-h-48 overflow-y-auto rounded-lg border border-text-secondary/15
									bg-bg-tertiary
								"
							>
								<div className="p-2.5">
									<div className="overflow-hidden text-xs/relaxed text-text-secondary italic">
										<MarkdownContent content={segment.text} />
									</div>
								</div>
							</div>
						);
					}

					// Completed or superseded thinking — always collapsible
					const isExpanded = expandedSections.has(segment.key);
					return (
						<div key={segment.key} className="flex flex-col gap-1.5">
							<button
								type="button"
								onClick={() => toggleSection(segment.key)}
								className={cn(
									'flex items-center gap-2 rounded-md px-3 py-1.5 text-xs',
									`
										cursor-pointer bg-bg-tertiary font-medium text-text-secondary
										transition-colors
									`,
									'hover:bg-border',
								)}
							>
								<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
								Show thinking
							</button>
							{isExpanded && (
								<div
									className="
										max-h-64 overflow-y-auto rounded-lg border border-text-secondary/10
										bg-bg-tertiary px-3 py-2.5 text-xs/relaxed text-text-secondary italic
									"
								>
									<MarkdownContent content={segment.text} />
								</div>
							)}
						</div>
					);
				}

				// ── Text segments ────────────────────────────────────
				// Active streaming text: bounded height with auto-scroll
				if (streaming && index === lastSegmentIndex) {
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

				// Completed text — fully visible in flow
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
			})}
		</div>
	);
}

/**
 * Check whether the tool result text represents an error.
 *
 * Error formats from the AI SDK:
 * - `[CODE] message` — ToolExecutionError thrown by our tool executors
 * - `Error executing tool: ...` — unexpected throw caught by the AI SDK
 * - `Input validation failed...` — Zod schema validation failure
 */
/**
 * Derive a short summary label for a completed tool call when structured
 * metadata is not available (e.g. loaded sessions where tool_result events
 * were not persisted).
 */
function deriveCompletedLabel(toolName: ToolName | undefined, _rawContent: string | undefined): string {
	// codemode has no structured metadata summary; its label is always the same.
	if (toolName === 'codemode') return 'Ran code';
	return 'Completed';
}

function isErrorResult(text: string): boolean {
	return /^\[[A-Z_]+\] /.test(text) || text.startsWith('Error executing tool:') || text.startsWith('Input validation failed');
}
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
 * Build a brief summary from structured metadata (CUSTOM tool_result event).
 * Returns undefined if no meaningful summary can be derived, so the caller
 * falls back to raw-parsing.
 */
function summarizeFromMetadata(toolName: ToolName | undefined, info: ToolMetadataInfo): string | undefined {
	const { metadata } = info;

	switch (toolName) {
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

		case 'asset_settings_get': {
			return 'Retrieved';
		}

		case 'asset_settings_update': {
			return Array.isArray(metadata.changes) && metadata.changes.length > 0 ? `${metadata.changes.length} changed` : 'No changes';
		}

		case 'bindings_get': {
			return 'Retrieved';
		}

		case 'bindings_update': {
			return Array.isArray(metadata.changes) && metadata.changes.length > 0 ? `${metadata.changes.length} changed` : 'No changes';
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
			if (Array.isArray(metadata.todos)) {
				const todos = metadata.todos.filter((item) => isTodoItemDisplay(item));
				if (todos.length > 0) return summarizeTodos(todos);
			}
			return undefined;
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
			return 'Legacy browser debug';
		}

		case 'browser_execute': {
			return 'Browser run';
		}

		case 'browser_markdown': {
			return 'Read as Markdown';
		}

		case 'browser_extract': {
			return 'Extracted data';
		}

		case 'browser_links': {
			return 'Listed links';
		}

		case 'browser_scrape': {
			return 'Scraped elements';
		}

		case 'test_run': {
			if (typeof metadata.passed === 'number' && typeof metadata.failed === 'number') {
				if (metadata.failed === 0) return `${metadata.passed} passed`;
				return `${metadata.failed} failed, ${metadata.passed} passed`;
			}
			return undefined;
		}

		case 'image_generate': {
			if (typeof metadata.sizeKilobytes === 'string') {
				return `Generated (${metadata.sizeKilobytes} KB)`;
			}
			return 'Generated';
		}

		case 'sub_agent': {
			if (typeof metadata.iterations === 'number') {
				return `${metadata.iterations} turn${metadata.iterations === 1 ? '' : 's'}`;
			}
			return 'Completed';
		}

		case 'user_question': {
			return undefined;
		}

		case 'bash': {
			if (typeof metadata.exitCode === 'number') {
				return metadata.exitCode === 0 ? 'Done' : `Exit ${metadata.exitCode}`;
			}
			return undefined;
		}

		case 'codemode': {
			return 'Ran code';
		}

		default: {
			return undefined;
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

function isTodoItemDisplay(item: unknown): item is TodoItemDisplay {
	return (
		isRecord(item) &&
		typeof item.id === 'string' &&
		typeof item.content === 'string' &&
		(item.status === 'pending' || item.status === 'in_progress' || item.status === 'completed') &&
		(item.priority === 'high' || item.priority === 'medium' || item.priority === 'low')
	);
}

function parseTodosFromRawResult(rawResult: string | undefined): TodoItemDisplay[] | undefined {
	if (!rawResult) return undefined;
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (Array.isArray(parsed)) {
			return parsed.filter((item) => isTodoItemDisplay(item));
		}
		if (isRecord(parsed) && Array.isArray(parsed.todos)) {
			return parsed.todos.filter((item) => isTodoItemDisplay(item));
		}
	} catch {
		// Not JSON
	}
	return undefined;
}

function summarizeTodos(todos: TodoItemDisplay[]): string {
	const completed = todos.filter((item) => item.status === 'completed').length;
	return `${completed}/${todos.length} completed`;
}

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

function stringifyConfigValue(value: unknown): string {
	if (Array.isArray(value)) return value.length > 0 ? value.join(', ') : '[]';
	if (typeof value === 'boolean') return value ? 'enabled' : 'disabled';
	if (typeof value === 'string') return value;
	return value === undefined ? 'default' : String(value);
}

function InlineKeyValueState({ title, entries }: { title: string; entries: Array<{ key: string; value: unknown }> }) {
	if (entries.length === 0) return;

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
				<Settings className="size-3.5" />
				{title}
			</div>
			<div className="flex flex-col gap-1">
				{entries.map((entry) => (
					<div
						key={entry.key}
						className="
							flex items-center justify-between gap-3 rounded-md bg-bg-primary px-2.5
							py-1.5 text-xs
						"
					>
						<span className="text-text-secondary">{entry.key}</span>
						<span className="min-w-0 truncate font-mono text-text-primary">{stringifyConfigValue(entry.value)}</span>
					</div>
				))}
			</div>
		</div>
	);
}

function getAssetSettingsEntries(metadata: Record<string, unknown> | undefined): Array<{ key: string; value: unknown }> | undefined {
	const settings = metadata && isRecord(metadata.assetSettings) ? metadata.assetSettings : undefined;
	if (!settings) return undefined;
	return [
		{ key: 'not_found_handling', value: settings.not_found_handling },
		{ key: 'html_handling', value: settings.html_handling },
		{ key: 'run_worker_first', value: settings.run_worker_first },
	];
}

function getBindingsEntries(metadata: Record<string, unknown> | undefined): Array<{ key: string; value: unknown }> | undefined {
	const bindingsConfig = metadata && isRecord(metadata.bindingsConfig) ? metadata.bindingsConfig : undefined;
	if (!bindingsConfig) return undefined;
	return [{ key: 'storage', value: bindingsConfig.storage === true }];
}

/**
 * Extract the `result` string from a structured tool result JSON.
 * Used by the expandable detail view to display the human-readable diff/summary.
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
		case 'lint_fix': {
			// Returns { result: "diff...", linesAdded, ... }
			// Show the diff/result text (fallback for when InlineDiffView is unavailable, e.g. page reload)
			return extractResultField(rawResult) ?? rawResult;
		}

		case 'plan_update': {
			// Returns { result: "summary..." }
			return extractResultField(rawResult) ?? rawResult;
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

		case 'browser_execute':
		case 'browser_markdown':
		case 'browser_extract':
		case 'browser_links':
		case 'browser_scrape': {
			return rawResult;
		}

		case 'codemode': {
			// Codemode returns { result, error?, logs? }. Surface console logs and
			// the return value legibly instead of dumping the raw envelope.
			try {
				const parsed: unknown = JSON.parse(rawResult);
				if (isRecord(parsed) && ('logs' in parsed || 'result' in parsed || 'error' in parsed)) {
					const sections: string[] = [];
					if (Array.isArray(parsed.logs) && parsed.logs.length > 0) {
						const logText = parsed.logs.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
						sections.push(`Console:\n${logText}`);
					}
					if (typeof parsed.error === 'string' && parsed.error) {
						sections.push(`Error: ${parsed.error}`);
					}
					if (parsed.result !== undefined && parsed.result !== null) {
						const resultText = typeof parsed.result === 'string' ? parsed.result : JSON.stringify(parsed.result, undefined, 2);
						if (resultText && resultText !== '""') {
							sections.push(`Result:\n${resultText}`);
						}
					}
					if (sections.length > 0) {
						return sections.join('\n\n');
					}
				}
			} catch {
				// Not JSON — fall through to raw
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

		case 'sub_agent': {
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
 * Tool results use a `{ content: text }` envelope format for consistent
 * parsing by the AI SDK. The result arrives on the client as a JSON string
 * `'{"content":"..."}'` that this helper unwraps.
 */
function unwrapToolContent(value: unknown): string | undefined {
	if (typeof value === 'string') {
		try {
			const parsed: unknown = JSON.parse(value);
			if (isRecord(parsed) && typeof parsed.content === 'string') {
				return parsed.content;
			}
			// The AI SDK wraps tool execution errors as {"error":"..."}
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
 * The result is in ToolResultPart.result (string).
 */
function getToolResultContent(toolResult?: ToolResultPart): string | undefined {
	if (toolResult && typeof toolResult.result === 'string' && toolResult.result) {
		return unwrapToolContent(toolResult.result);
	}
	return undefined;
}
function isToolError(toolResult?: ToolResultPart): boolean {
	if (toolResult?.isError) return true;
	const content = getToolResultContent(toolResult);
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
const CONTENT_STREAMING_TOOLS = new Set<string>(['codemode', 'bash']);

/**
 * A labeled monospace block used in the codemode expanded view to show the
 * executed code and its output separately.
 */
function InlineCodeSection({ label, content }: { label: string; content: string }) {
	if (!content) return;
	return (
		<div className="flex flex-col gap-1">
			<span
				className="
					text-2xs font-medium tracking-wide text-text-secondary/70 uppercase
				"
			>
				{label}
			</span>
			<pre
				className="
					max-h-60 overflow-auto rounded-md bg-bg-primary p-2.5 font-mono
					text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
				"
			>
				{content}
			</pre>
		</div>
	);
}

function InlineToolCall({
	toolCall,
	toolResult,
	toolErrors,
	toolMetadata,
	fileDiffContent,
	subAgentActivities,
	projectId,
	isStreaming,
	isExpanded,
	onToggleExpand,
}: {
	toolCall: ToolCallPart;
	toolResult?: ToolResultPart;
	toolErrors?: Map<string, ToolErrorInfo>;
	toolMetadata?: Map<string, ToolMetadataInfo>;
	fileDiffContent?: Map<string, { beforeContent: string; afterContent: string }>;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	projectId?: string;
	isStreaming?: boolean;
	isExpanded: boolean;
	onToggleExpand: () => void;
}) {
	const knownToolName: ToolName | undefined = isToolName(toolCall.toolName) ? toolCall.toolName : undefined;
	const displayToolName = toolCall.toolName || 'unknown';

	// Derive execution state from whether a result exists
	const isCompleted = toolResult !== undefined;
	const isExecuting = !toolResult && !!isStreaming;
	const isCancelled = !toolResult && !isStreaming;
	const rawResultContent = getToolResultContent(toolResult);
	const isUnknownTool = knownToolName === undefined;

	// Whether tool arguments are still being streamed (empty arguments = still receiving deltas)
	const isArgumentsStreaming = isStreaming && !isCompleted && Object.keys(toolCall.arguments).length === 0;

	// Structured metadata from tool_result events (populated during streaming)
	const structuredMetadata = toolMetadata?.get(toolCall.toolCallId);
	const metadata = structuredMetadata?.metadata;

	// Structured error data from tool_error events.
	// Unknown (unsupported/hallucinated) tools are NOT treated as execution
	// errors — they render with neutral styling instead of the alarming red path.
	const structuredError = toolErrors?.get(toolCall.toolCallId);
	const isError = structuredError !== undefined || isToolError(toolResult);

	// Extract file paths from tool arguments.
	// Accept `file_path` (schema-defined), `path` (legacy/search tools), and `filePath` (model sometimes hallucinates this key).
	const input = toolCall.arguments;
	const singlePath =
		typeof input.file_path === 'string'
			? input.file_path
			: typeof input.path === 'string'
				? input.path
				: typeof input.filePath === 'string'
					? input.filePath
					: undefined;
	let fromPath: string | undefined;
	let toPath: string | undefined;
	let pattern: string | undefined;
	let extraLabel: string | undefined;
	if (!singlePath && typeof input.from_path === 'string' && typeof input.to_path === 'string') {
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
	if (typeof input.prompt === 'string') {
		extraLabel = input.prompt;
	}

	// Streaming content preview for code/command tools (codemode, bash)
	const streamingContent =
		isArgumentsStreaming && CONTENT_STREAMING_TOOLS.has(toolCall.toolName)
			? typeof input.code === 'string'
				? input.code
				: typeof input.command === 'string'
					? input.command
					: undefined
			: undefined;

	// Executed code for codemode — shown in the expanded detail so the code
	// stays visible after streaming completes (streamingContent clears on done).
	const codemodeCode = knownToolName === 'codemode' && typeof input.code === 'string' ? input.code : undefined;

	// Auto-scroll ref for the streaming content preview
	const streamingPreviewReference = useRef<HTMLPreElement>(null);
	useEffect(() => {
		if (streamingContent && streamingPreviewReference.current) {
			streamingPreviewReference.current.scrollTop = streamingPreviewReference.current.scrollHeight;
		}
	}, [streamingContent]);

	// Extract TODOs — prefer structured metadata, fall back to parsing raw result
	const metadataTodos = metadata && Array.isArray(metadata.todos) ? metadata.todos.filter((item) => isTodoItemDisplay(item)) : undefined;
	const todos = metadataTodos ?? parseTodosFromRawResult(rawResultContent);
	const assetSettingsEntries =
		knownToolName === 'asset_settings_get' || knownToolName === 'asset_settings_update' ? getAssetSettingsEntries(metadata) : undefined;
	const bindingsEntries =
		knownToolName === 'bindings_get' || knownToolName === 'bindings_update' ? getBindingsEntries(metadata) : undefined;
	const planFilePath = knownToolName === 'plan_update' && typeof metadata?.planFilePath === 'string' ? metadata.planFilePath : undefined;

	// Extract file-edit stats from structured metadata (lint_fix).
	// Metadata is always available — persisted with the session for loaded sessions.
	const linesAdded = typeof metadata?.linesAdded === 'number' ? metadata.linesAdded : undefined;
	const linesRemoved = typeof metadata?.linesRemoved === 'number' ? metadata.linesRemoved : undefined;
	const lintErrorCount =
		typeof metadata?.diagnostics === 'object' && Array.isArray(metadata.diagnostics) ? metadata.diagnostics.length : undefined;
	const hasEditStats = linesAdded !== undefined && (linesAdded > 0 || (linesRemoved ?? 0) > 0 || (lintErrorCount ?? 0) > 0);

	// Build summary text from structured metadata (single code path for both
	// live-streamed and loaded sessions — no raw-text fallbacks).
	const resultSummary = isUnknownTool
		? `Unsupported tool: ${displayToolName}`
		: isError
			? structuredError
				? shortenErrorFromStructured(structuredError)
				: 'Failed'
			: hasEditStats
				? undefined
				: structuredMetadata
					? summarizeFromMetadata(knownToolName, structuredMetadata)
					: isCompleted
						? deriveCompletedLabel(knownToolName, rawResultContent)
						: isCancelled
							? 'Cancelled'
							: isExecuting
								? 'Running...'
								: undefined;

	// Diagnostics from metadata for expanded view
	const diagnostics = metadata && Array.isArray(metadata.diagnostics) ? metadata.diagnostics : undefined;

	// Diff content from the file_changed CUSTOM event (carries beforeContent/afterContent)
	const diffContent = fileDiffContent?.get(toolCall.toolCallId);
	const hasDiffContent = diffContent !== undefined;

	// Every completed tool call with content or a structured error is expandable.
	// File-editing tools with before/after content are also expandable (for the diff view).
	const hasDetailContent = rawResultContent !== undefined || structuredError !== undefined || hasDiffContent || codemodeCode !== undefined;
	const expandable = !isUnknownTool && (isCompleted || codemodeCode !== undefined) && hasDetailContent;

	return (
		<div className="flex min-w-0 animate-chat-item flex-col gap-1.5">
			<div
				onClick={() => expandable && onToggleExpand()}
				onKeyDown={
					expandable
						? (event) => {
								if (event.key === 'Enter' || event.key === ' ') {
									event.preventDefault();
									onToggleExpand();
								}
							}
						: undefined
				}
				role={expandable ? 'button' : undefined}
				tabIndex={expandable ? 0 : undefined}
				className={cn(
					`
						flex flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden rounded-md
						px-3 py-1.5 text-xs
					`,
					isUnknownTool && 'bg-bg-tertiary text-text-secondary',
					!isUnknownTool && isCompleted && !isError && 'bg-success/5 text-text-secondary',
					!isUnknownTool && isError && 'bg-error/5 text-error',
					!isUnknownTool && !isCompleted && !isError && 'bg-bg-tertiary text-text-secondary',
					expandable &&
						`
							cursor-pointer transition-colors
							hover:bg-bg-tertiary
						`,
				)}
			>
				{expandable ? (
					<ChevronRight className={cn('size-3 shrink-0 transition-transform', isExpanded && 'rotate-90')} />
				) : !isCompleted && !isError && !isCancelled ? (
					<Spinner className="size-3 shrink-0 text-accent" />
				) : undefined}
				<span
					className={cn(
						'shrink-0',
						isUnknownTool ? 'text-text-secondary' : isCompleted && !isError ? 'text-success' : isError ? 'text-error' : undefined,
					)}
				>
					{knownToolName ? <ToolIcon name={knownToolName} /> : <Wrench className="size-3" />}
				</span>
				<span className="shrink-0 font-medium capitalize">{displayToolName.replaceAll('_', ' ')}</span>
				{singlePath && (
					<FileReference
						path={singlePath}
						className="max-w-48 truncate"
						interactive={false}
						onClick={(event) => {
							event.stopPropagation();
						}}
					/>
				)}
				{fromPath && toPath && (
					<span className="flex max-w-48 items-center gap-1">
						<FileReference
							path={fromPath}
							className="truncate"
							interactive={false}
							onClick={(event) => {
								event.stopPropagation();
							}}
						/>
						<span className="shrink-0 text-text-secondary">→</span>
						<FileReference
							path={toPath}
							className="truncate"
							interactive={false}
							onClick={(event) => {
								event.stopPropagation();
							}}
						/>
					</span>
				)}
				{pattern && (
					<Tooltip content={pattern} side="bottom">
						<span className="max-w-48 truncate font-mono text-text-secondary">{pattern}</span>
					</Tooltip>
				)}
				{!singlePath && !fromPath && !pattern && extraLabel && (
					<Tooltip content={extraLabel} side="bottom">
						<span className="max-w-48 truncate text-text-secondary">
							{knownToolName === 'sub_agent' && typeof metadata?.shortTitle === 'string'
								? metadata.shortTitle
								: extraLabel.length > 60
									? extraLabel.slice(0, 60) + '...'
									: extraLabel}
						</span>
					</Tooltip>
				)}
				{planFilePath && (
					<FileReference
						path={planFilePath}
						className="max-w-48 truncate"
						interactive={false}
						onClick={(event) => {
							event.stopPropagation();
						}}
					/>
				)}
				{resultSummary && <span className="ml-auto min-w-0 truncate text-text-secondary">{resultSummary}</span>}
				{hasEditStats && (
					<span className={cn('flex shrink-0 items-center gap-1.5', !resultSummary && 'ml-auto')}>
						{linesAdded !== undefined && linesAdded > 0 && (
							<span className="font-mono text-success" title={`${linesAdded} line${linesAdded === 1 ? '' : 's'} added`}>
								+{linesAdded}
							</span>
						)}
						{linesRemoved !== undefined && linesRemoved > 0 && (
							<span className="font-mono text-error" title={`${linesRemoved} line${linesRemoved === 1 ? '' : 's'} removed`}>
								-{linesRemoved}
							</span>
						)}
						{lintErrorCount !== undefined && lintErrorCount > 0 && (
							<span className="font-mono text-warning" title={`${lintErrorCount} lint error${lintErrorCount === 1 ? '' : 's'}`}>
								⚠ {lintErrorCount}
							</span>
						)}
					</span>
				)}
			</div>
			{streamingContent && (
				<pre
					ref={streamingPreviewReference}
					className="
						max-h-40 overflow-auto rounded-md border border-accent/20 bg-bg-primary
						p-2.5 font-mono text-2xs/relaxed break-all whitespace-pre-wrap
						text-text-secondary
					"
				>
					{streamingContent}
				</pre>
			)}
			{isExpanded && codemodeCode !== undefined && (
				<div className="flex flex-col gap-1.5">
					<InlineCodeSection label="Code" content={codemodeCode} />
					{rawResultContent !== undefined && (
						<InlineCodeSection label="Output" content={getExpandableDetailText('codemode', rawResultContent, structuredError)} />
					)}
				</div>
			)}
			{isExpanded &&
				hasDetailContent &&
				codemodeCode === undefined &&
				knownToolName !== 'sub_agent' &&
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
			{knownToolName === 'sub_agent' && (
				<InlineSubAgentActivity
					toolCallId={toolCall.toolCallId}
					subAgentActivities={subAgentActivities}
					metadata={metadata}
					rawResultContent={rawResultContent}
					projectId={projectId}
					isExpanded={isExpanded}
				/>
			)}
			{todos && todos.length > 0 && <InlineTodoList todos={todos} />}
			{assetSettingsEntries && <InlineKeyValueState title="Asset settings" entries={assetSettingsEntries} />}
			{bindingsEntries && <InlineKeyValueState title="Bindings" entries={bindingsEntries} />}
		</div>
	);
}

function InlineSubAgentActivity({
	toolCallId,
	subAgentActivities,
	metadata,
	rawResultContent,
	projectId,
	isExpanded,
}: {
	toolCallId: string;
	subAgentActivities?: Record<string, SubAgentActivityRecord>;
	metadata: Record<string, unknown> | undefined;
	rawResultContent: string | undefined;
	projectId: string | undefined;
	isExpanded: boolean;
}) {
	const sessionId = useStore((state) => state.sessionId);
	const activityRecord = subAgentActivities?.[toolCallId];
	const tools = activityRecord?.tools ?? [];
	const streamingText = activityRecord?.streamingText;
	const subAgentDebugLogId = activityRecord?.debugLogId ?? (typeof metadata?.debugLogId === 'string' ? metadata.debugLogId : undefined);

	// Use rawResultContent (final output) when available, otherwise show live streaming text
	const responseText = rawResultContent ?? streamingText;

	const handleDownloadLog = useCallback(() => {
		if (!subAgentDebugLogId || !projectId) return;
		void downloadDebugLog(projectId, subAgentDebugLogId, sessionId).catch(() => {});
	}, [subAgentDebugLogId, projectId, sessionId]);

	// When collapsed, only render if there's *active* streaming (no final result yet)
	if (!isExpanded && (!streamingText || rawResultContent) && tools.length === 0) return;

	return (
		<div className="flex flex-col gap-2 rounded-md bg-bg-primary p-2">
			{isExpanded && tools.length > 0 && (
				<div className="flex flex-col gap-0.5">
					<div
						className="
							mb-1 flex items-center gap-1.5 text-2xs font-semibold tracking-wider
							text-text-secondary uppercase
						"
					>
						<Bot className="size-3" />
						Sub-agent activity ({tools.length} tool call{tools.length === 1 ? '' : 's'})
					</div>
					{tools.map((entry, index) => {
						const entryToolName: ToolName | undefined = isToolName(entry.toolName) ? entry.toolName : undefined;
						const entryPath =
							typeof entry.metadata?.path === 'string'
								? entry.metadata.path
								: typeof entry.metadata?.file_path === 'string'
									? entry.metadata.file_path
									: undefined;
						return (
							<div
								key={index}
								className={cn(
									'flex items-center gap-2 rounded-sm px-2 py-0.5 text-2xs',
									entry.isError ? 'text-error' : 'text-text-secondary',
								)}
							>
								<span className="shrink-0">{entryToolName ? <ToolIcon name={entryToolName} /> : <Wrench className="size-3" />}</span>
								<span className="font-medium capitalize">{entry.toolName.replaceAll('_', ' ')}</span>
								{entryPath && <span className="max-w-32 truncate font-mono opacity-70">{entryPath}</span>}
								{entry.title && entry.title !== 'Error' && <span className="ml-auto shrink-0 text-text-secondary/70">{entry.title}</span>}
								{entry.isError && <span className="ml-auto shrink-0 text-error">Failed</span>}
							</div>
						);
					})}
				</div>
			)}
			{responseText && (
				<details className="group">
					<summary
						className="
							cursor-pointer text-2xs font-medium text-text-secondary transition-colors
							hover:text-text-primary
						"
					>
						<ChevronRight className="mr-1 inline size-3 transition-transform group-open:rotate-90" />
						{rawResultContent ? 'Sub-agent response' : 'Sub-agent output (streaming…)'}
					</summary>
					<pre
						className="
							mt-1.5 max-h-60 overflow-auto rounded-md bg-bg-secondary p-2 font-mono
							text-2xs/relaxed break-all whitespace-pre-wrap text-text-secondary
						"
					>
						{responseText}
					</pre>
				</details>
			)}
			{isExpanded && subAgentDebugLogId && projectId && (
				<button
					onClick={handleDownloadLog}
					className={cn(
						`
							inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-md px-2
							py-1
						`,
						'text-2xs font-medium text-text-secondary transition-colors',
						'hover:bg-bg-tertiary hover:text-text-primary',
					)}
				>
					<Download className="size-3" />
					Download sub-agent log
				</button>
			)}
		</div>
	);
}

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

export function AgentError({
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

function abbreviateQueuedMessage(content: string, maxLength = 72): string {
	const normalized = content.replaceAll(/\s+/g, ' ').trim();
	if (normalized.length <= maxLength) {
		return normalized;
	}
	return `${normalized.slice(0, maxLength - 1).trimEnd()}...`;
}

const QUEUED_PREVIEW_LIMIT = 3;

function getQueuedMessageText(message: ChatMessage): string {
	return messagePartsToPlainText(message.parts);
}

export function QueuedSteeringStrip({
	messages,
	currentUserId,
	sessionParticipants,
	localOnlyMessageIds,
	onRemoveMessage,
}: {
	messages: ChatMessage[];
	currentUserId?: string;
	sessionParticipants: Record<string, SessionParticipantProfile>;
	localOnlyMessageIds?: Set<string>;
	onRemoveMessage: (messageId: string) => void;
}) {
	const [isExpanded, setIsExpanded] = useState(false);
	const rootReference = useRef<HTMLDivElement>(null);
	const orderedMessages = useMemo(() => [...messages], [messages]);
	const stackDepth = Math.min(messages.length, QUEUED_PREVIEW_LIMIT);
	const handleRemoveMessage = useCallback(
		(messageId: string) => {
			setIsExpanded(true);
			onRemoveMessage(messageId);
		},
		[onRemoveMessage],
	);

	useEffect(() => {
		if (!isExpanded) return;

		const handlePointerDown = (event: PointerEvent) => {
			if (!(event.target instanceof Node) || !rootReference.current?.contains(event.target)) {
				setIsExpanded(false);
			}
		};

		globalThis.addEventListener('pointerdown', handlePointerDown);
		return () => globalThis.removeEventListener('pointerdown', handlePointerDown);
	}, [isExpanded]);

	return (
		<div
			ref={rootReference}
			className="relative z-20 h-10 touch-pan-y overflow-visible"
			style={{ height: 44 } satisfies CSSProperties}
			onMouseEnter={() => setIsExpanded(true)}
			onMouseLeave={() => setIsExpanded(false)}
		>
			<AnimatePresence initial={false}>
				{orderedMessages.map((message, index) => {
					const collapsedIndex = Math.min(index, stackDepth - 1);
					const offset = isExpanded ? index * 42 : collapsedIndex * 4;
					const hiddenWhenCollapsed = !isExpanded && index >= stackDepth;
					const isFrontCard = index === 0;
					const previewText = abbreviateQueuedMessage(getQueuedMessageText(message), 64);
					const isInteractiveCard = isExpanded || isFrontCard;
					const isClientOnly = localOnlyMessageIds?.has(message.id) ?? false;
					const authorName = resolveAuthorName(message.authorUserId, currentUserId, sessionParticipants);
					const authorColor = resolveAuthorColor(message.authorUserId, sessionParticipants);

					return (
						<motion.div
							key={message.id}
							layout={isExpanded ? 'position' : false}
							initial={{ y: -(offset + 8), opacity: 0 }}
							animate={{ y: -offset, opacity: hiddenWhenCollapsed ? 0 : 1 }}
							exit={{ y: -(offset + 8), opacity: 0 }}
							transition={{ duration: 0.14, ease: 'easeOut' }}
							className={cn('absolute inset-x-0 bottom-0', hiddenWhenCollapsed && 'pointer-events-none')}
							style={{ zIndex: orderedMessages.length - index }}
						>
							<div
								className={cn(
									`
										flex h-10 items-center gap-0.5 rounded-lg border px-3
										transition-colors duration-120
									`,
									`
										border-purple-500/25
										bg-[color-mix(in_oklab,var(--color-bg-secondary)_90%,var(--color-purple-500)_10%)]
										shadow-[inset_0_0_0_1px_rgba(168,85,247,0.05)]
									`,
									isClientOnly && 'border-dashed',
									'pr-2',
									isFrontCard && !isExpanded
										? `
											hover:border-purple-500/40
											hover:bg-[color-mix(in_oklab,var(--color-bg-secondary)_88%,var(--color-purple-500)_12%)]
										`
										: undefined,
								)}
							>
								{isFrontCard ? (
									<button
										type="button"
										onClick={() => setIsExpanded((current) => !current)}
										className="flex min-w-0 flex-1 items-center gap-2 text-left"
										aria-label={isExpanded ? 'Hide queued messages' : `Show ${messages.length} queued messages`}
									>
										<div className="flex min-w-0 flex-1 items-center gap-2">
											<Pill size="xs" color="purple">
												{messages.length} queued
											</Pill>
											<span
												className="size-2.5 shrink-0 rounded-full border border-white/15"
												style={authorColor ? { backgroundColor: authorColor } : undefined}
												title={authorName}
											/>
											<span className="min-w-0 truncate text-sm font-medium text-text-primary">{previewText}</span>
										</div>
									</button>
								) : isExpanded ? (
									<div className="flex min-w-0 flex-1 items-center gap-2 text-left">
										<span
											className="size-2.5 shrink-0 rounded-full border border-white/15"
											style={authorColor ? { backgroundColor: authorColor } : undefined}
											title={authorName}
										/>
										<span className="min-w-0 truncate text-sm font-medium text-text-primary">{previewText}</span>
									</div>
								) : (
									<div aria-hidden className="flex min-w-0 flex-1 items-center" />
								)}
								<button
									type="button"
									onClick={() => handleRemoveMessage(message.id)}
									disabled={!isInteractiveCard}
									className={cn(
										`
											inline-flex size-6 shrink-0 items-center justify-center rounded-md
											border transition-colors
										`,
										`
											border-purple-500/20 text-text-secondary
											hover:border-purple-500/35 hover:bg-purple-500/10
											hover:text-text-primary
										`,
										!isInteractiveCard && 'pointer-events-none opacity-0',
									)}
									aria-label={isInteractiveCard ? 'Remove queued message' : undefined}
									tabIndex={isInteractiveCard ? 0 : -1}
								>
									<X className="size-3.5" />
								</button>
							</div>
						</motion.div>
					);
				})}
			</AnimatePresence>
		</div>
	);
}
