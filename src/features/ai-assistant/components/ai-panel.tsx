/**
 * AI Assistant Panel Component
 *
 * Chat interface for interacting with the AI coding assistant.
 * Features: welcome screen with suggestions, collapsible tool calls,
 * collapsible reasoning, error handling with retry, session management,
 * snapshot revert buttons on user messages.
 */

import {
	AlertCircle,
	Bot,
	ChevronDown,
	Clock,
	Eye,
	FastForward,
	FileText,
	Loader2,
	MoveRight,
	Pencil,
	Plus,
	RefreshCw,
	RotateCcw,
	Send,
	Square,
	Trash2,
} from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { useSnapshots } from '@/features/snapshots';
import { startAIChat, type AIStreamEvent } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import { FileMentionDropdown } from './file-mention-dropdown';
import { FileReference } from './file-reference';
import { MarkdownContent } from './markdown-content';
import { RevertConfirmDialog } from './revert-confirm-dialog';
import { RichTextInput, type RichTextInputHandle } from './rich-text-input';
import { useAiSessions } from '../hooks/use-ai-sessions';
import { useFileMention } from '../hooks/use-file-mention';
import { parseTextToSegments, segmentsHaveContent, segmentsToPlainText, type InputSegment } from '../lib/input-segments';

import type { AgentContent, AgentMessage, ToolName } from '@shared/types';

// =============================================================================
// Helper functions
// =============================================================================

const VALID_TOOL_NAMES: ReadonlySet<string> = new Set<ToolName>(['list_files', 'read_file', 'write_file', 'delete_file', 'move_file']);

function isToolName(value: unknown): value is ToolName {
	return typeof value === 'string' && VALID_TOOL_NAMES.has(value);
}

function getEventStringField(event: AIStreamEvent, field: string): string {
	const value = event[field];
	return typeof value === 'string' ? value : '';
}

function getEventToolName(event: AIStreamEvent, field: string): ToolName {
	const value = event[field];
	if (isToolName(value)) {
		return value;
	}
	return 'list_files';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}

function getEventObjectField(event: AIStreamEvent, field: string): Record<string, unknown> {
	const value = event[field];
	return isRecord(value) ? value : {};
}

function getEventBooleanField(event: AIStreamEvent, field: string): boolean | undefined {
	const value = event[field];
	return typeof value === 'boolean' ? value : undefined;
}

// =============================================================================
// Tool icon helper
// =============================================================================

function ToolIcon({ name, className }: { name: ToolName; className?: string }) {
	switch (name) {
		case 'read_file':
		case 'list_files': {
			return <Eye className={cn('size-3', className)} />;
		}
		case 'write_file': {
			return <Pencil className={cn('size-3', className)} />;
		}
		case 'delete_file': {
			return <Trash2 className={cn('size-3', className)} />;
		}
		case 'move_file': {
			return <MoveRight className={cn('size-3', className)} />;
		}
		default: {
			return <FileText className={cn('size-3', className)} />;
		}
	}
}

// =============================================================================
// AI Suggestion presets
// =============================================================================

const AI_SUGGESTIONS = [
	{ label: 'Add dark mode', prompt: 'Add a dark mode toggle to the app' },
	{ label: 'Explain project', prompt: 'Explain what this project does' },
	{ label: 'Add validation', prompt: 'Add form validation to the input fields' },
];

// =============================================================================
// Component
// =============================================================================

/**
 * AI assistant panel with chat interface.
 */
export function AIPanel({ projectId, className }: { projectId: string; className?: string }) {
	const [segments, setSegments] = useState<InputSegment[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [streamingContent, setStreamingContent] = useState<AgentContent[] | undefined>();
	const [needsContinuation, setNeedsContinuation] = useState(false);
	const inputReference = useRef<RichTextInputHandle>(null);
	const scrollReference = useRef<HTMLDivElement>(null);
	const abortControllerReference = useRef<AbortController | undefined>(undefined);
	const assistantContentReference = useRef<AgentContent[]>([]);
	const userMessageIndexReference = useRef<number>(-1);

	// Derived plain text for the file mention hook
	const inputPlainText = useMemo(() => segmentsToPlainText(segments), [segments]);
	const hasContent = useMemo(() => segmentsHaveContent(segments), [segments]);

	// Revert confirmation dialog state
	const [pendingRevert, setPendingRevert] = useState<{ snapshotId: string; messageIndex: number } | undefined>();

	// Store state
	const {
		history,
		isProcessing,
		statusMessage,
		aiError,
		messageSnapshots,
		files,
		addMessage,
		clearHistory,
		setProcessing,
		setStatusMessage,
		setAiError,
		setMessageSnapshot,
		removeMessagesAfter,
		removeMessagesFrom,
	} = useStore();

	// File mention autocomplete
	const handleFileMentionSelect = useCallback((path: string, triggerIndex: number, queryLength: number) => {
		inputReference.current?.insertMention(path, triggerIndex, queryLength);
	}, []);

	const {
		isOpen: isFileMentionOpen,
		results: fileMentionResults,
		selectedIndex: fileMentionSelectedIndex,
		handleKeyDown: handleFileMentionKeyDown,
		selectFile: selectMentionFile,
	} = useFileMention({
		files,
		segments,
		inputValue: inputPlainText,
		cursorPosition,
		onSelect: handleFileMentionSelect,
	});

	// Session persistence
	const { savedSessions, handleLoadSession, saveCurrentSession } = useAiSessions({ projectId });

	// Snapshot hook for revert
	const { revertSnapshotAsync, isReverting } = useSnapshots({ projectId });

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [history, statusMessage, aiError, streamingContent, needsContinuation]);

	// Focus input on mount
	useEffect(() => {
		// Small delay to let contentEditable mount
		requestAnimationFrame(() => {
			inputReference.current?.focus();
		});
	}, []);

	// Send message
	const handleSend = useCallback(
		async (messageOverride?: string) => {
			const messageText = messageOverride ?? inputPlainText.trim();
			if (!messageText || isProcessing) return;

			// Clear any previous error or continuation prompt
			setAiError(undefined);
			setNeedsContinuation(false);

			const userMessage: AgentMessage = {
				role: 'user',
				content: [{ type: 'text', text: messageText }],
			};

			addMessage(userMessage);
			// Track the index of this user message for snapshot association
			userMessageIndexReference.current = history.length; // index of the user message we just added
			setSegments([]);
			inputReference.current?.clear();
			setProcessing(true);
			setStatusMessage('Thinking...');

			// Create abort controller for cancellation
			abortControllerReference.current = new AbortController();

			const assistantContent: AgentContent[] = [];
			assistantContentReference.current = assistantContent;
			setStreamingContent([]);
			let wasCancelled = false;

			try {
				// Convert history to API format
				const apiHistory = history.map((message) => ({
					role: message.role,
					content: message.content,
				}));

				await startAIChat(projectId, messageText, apiHistory, abortControllerReference.current.signal, (event: AIStreamEvent) => {
					switch (event.type) {
						case 'status': {
							const statusText = getEventStringField(event, 'message');
							if (statusText) {
								setStatusMessage(statusText);
							}
							break;
						}
						case 'message': {
							// Each message event is a distinct text chunk from the server.
							// Always push a new text block so interleaving with tool
							// calls is preserved in the rendered output.
							const text = getEventStringField(event, 'content');
							if (text) {
								assistantContent.push({ type: 'text', text });
								setStreamingContent([...assistantContent]);
								setStatusMessage(undefined);
							}
							break;
						}
						case 'tool_call': {
							// Server sends: { type: 'tool_call', tool, id, args }
							const toolName = getEventToolName(event, 'tool');
							setStatusMessage(`Using tool: ${toolName}`);
							assistantContent.push({
								type: 'tool_use',
								id: getEventStringField(event, 'id'),
								name: toolName,
								input: getEventObjectField(event, 'args'),
							});
							setStreamingContent([...assistantContent]);
							break;
						}
						case 'tool_result': {
							// Server sends: { type: 'tool_result', tool, tool_use_id, result }
							assistantContent.push({
								type: 'tool_result',
								tool_use_id: getEventStringField(event, 'tool_use_id'),
								content: getEventStringField(event, 'result'),
								is_error: getEventBooleanField(event, 'is_error'),
							});
							setStreamingContent([...assistantContent]);
							break;
						}
						case 'snapshot_created': {
							// Associate this snapshot with the user message that triggered it
							const snapshotId = getEventStringField(event, 'id');
							if (snapshotId && userMessageIndexReference.current >= 0) {
								setMessageSnapshot(userMessageIndexReference.current, snapshotId);
							}
							break;
						}
						case 'turn_complete':
						case 'done': {
							// Turn or stream complete — no action needed
							break;
						}
						case 'max_iterations_reached': {
							// Agent hit the iteration circuit breaker — prompt user to continue
							setNeedsContinuation(true);
							break;
						}
						case 'error': {
							// Surface SSE errors to the UI
							const errorMessage = getEventStringField(event, 'message') || 'An unknown error occurred';
							const errorCode = getEventStringField(event, 'code');
							setAiError({ message: errorMessage, code: errorCode || undefined });
							break;
						}
					}
				});

				// Add complete assistant message
				if (assistantContent.length > 0) {
					addMessage({
						role: 'assistant',
						content: assistantContent,
					});
				}
			} catch (error: unknown) {
				if (error instanceof Error && error.name === 'AbortError') {
					wasCancelled = true;
					// Preserve partial content on cancellation
					if (assistantContent.length > 0) {
						// Add a cancellation indicator to the last text block
						const lastText = [...assistantContent].toReversed().find((block) => block.type === 'text');
						if (lastText && lastText.type === 'text') {
							lastText.text += '\n\n_[Generation stopped]_';
						} else {
							assistantContent.push({ type: 'text', text: '_[Generation stopped]_' });
						}
						addMessage({
							role: 'assistant',
							content: assistantContent,
						});
					}
				} else if (error instanceof Error) {
					console.error('AI chat error:', error);
					setAiError({ message: error.message });
				}
			} finally {
				setProcessing(false);
				setStatusMessage(undefined);
				setStreamingContent(undefined);
				abortControllerReference.current = undefined;
				assistantContentReference.current = [];
				if (!wasCancelled) {
					userMessageIndexReference.current = -1;
				}

				// Auto-save the session after each AI response
				// Use a microtask so the store updates from addMessage() are committed first
				queueMicrotask(() => {
					void saveCurrentSession();
				});
			}
		},
		[
			inputPlainText,
			isProcessing,
			history,
			projectId,
			addMessage,
			setProcessing,
			setStatusMessage,
			setAiError,
			setMessageSnapshot,
			saveCurrentSession,
		],
	);

	// Handle keyboard shortcuts
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			// Let file mention dropdown handle keys first
			if (handleFileMentionKeyDown(event)) return;

			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void handleSend();
			}
		},
		[handleSend, handleFileMentionKeyDown],
	);

	// Cancel current request
	const handleCancel = useCallback(() => {
		abortControllerReference.current?.abort();
	}, []);

	// Retry last message
	const handleRetry = useCallback(() => {
		// Find the last user message text
		const lastUserMessage = [...history].toReversed().find((message) => message.role === 'user');
		if (!lastUserMessage) return;

		const text = lastUserMessage.content
			.filter((block): block is AgentContent & { type: 'text' } => block.type === 'text')
			.map((block) => block.text)
			.join('\n');

		// Clear the error
		setAiError(undefined);

		// Remove the errored assistant message (if any) — the last message might be an assistant error
		const lastMessage = history.at(-1);
		if (lastMessage && lastMessage.role === 'assistant') {
			removeMessagesAfter(history.length - 2);
		}

		// Re-send
		void handleSend(text);
	}, [history, setAiError, removeMessagesAfter, handleSend]);

	// Dismiss error
	const handleDismissError = useCallback(() => {
		setAiError(undefined);
	}, [setAiError]);

	// Open revert confirmation dialog
	const handleRevert = useCallback((snapshotId: string, messageIndex: number) => {
		setPendingRevert({ snapshotId, messageIndex });
	}, []);

	// Confirm revert (called from the dialog)
	const handleConfirmRevert = useCallback(
		async (snapshotId: string, messageIndex: number) => {
			// Cancel any ongoing generation first
			if (isProcessing) {
				abortControllerReference.current?.abort();
			}

			// Extract the user prompt text before removing messages
			const userMessage = history[messageIndex];
			const promptText =
				userMessage?.content
					.filter((block): block is AgentContent & { type: 'text' } => block.type === 'text')
					.map((block) => block.text)
					.join('\n') ?? '';

			try {
				await revertSnapshotAsync(snapshotId);

				// Remove the user message and all subsequent messages, clean up snapshot associations
				removeMessagesFrom(messageIndex);

				// Restore the prompt text into the input
				if (promptText) {
					setSegments([{ type: 'text', value: promptText }]);
					requestAnimationFrame(() => {
						inputReference.current?.focus();
					});
				}

				// Save the updated session
				queueMicrotask(() => {
					void saveCurrentSession();
				});
			} finally {
				setPendingRevert(undefined);
			}
		},
		[isProcessing, history, revertSnapshotAsync, removeMessagesFrom, saveCurrentSession],
	);

	// Handle suggestion click
	const handleSuggestion = useCallback(
		(prompt: string) => {
			void handleSend(prompt);
		},
		[handleSend],
	);

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Header */}
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex items-center gap-2">
					<Bot className="size-4 text-accent" />
					<span className="text-sm font-medium text-text-primary">AI Assistant</span>
				</div>
				<div className="flex items-center gap-1">
					{/* Session dropdown */}
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button variant="ghost" size="icon-sm" title="Sessions">
								<ChevronDown className="size-3" />
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end" className="w-56">
							{savedSessions.length === 0 ? (
								<div className="px-3 py-2 text-xs text-text-secondary">No saved sessions</div>
							) : (
								savedSessions.map((session) => (
									<DropdownMenuItem key={session.id} onSelect={() => handleLoadSession(session.id)}>
										<div className="flex w-full items-center justify-between">
											<span className="truncate text-sm">{session.label}</span>
											<span className="ml-2 shrink-0 text-2xs text-text-secondary">{formatRelativeTime(session.createdAt)}</span>
										</div>
									</DropdownMenuItem>
								))
							)}
						</DropdownMenuContent>
					</DropdownMenu>

					{/* New session */}
					<Tooltip content="New session">
						<Button variant="ghost" size="icon-sm" onClick={clearHistory}>
							<Plus className="size-3.5" />
						</Button>
					</Tooltip>
				</div>
			</div>

			{/* Messages */}
			<ScrollArea.Root className="flex-1 overflow-hidden">
				<ScrollArea.Viewport ref={scrollReference} className="size-full">
					<div className="flex flex-col gap-3 p-2">
						{history.length === 0 ? (
							<WelcomeScreen onSuggestionClick={handleSuggestion} />
						) : (
							history.map((message, index) => (
								<MessageBubble
									key={index}
									message={message}
									messageIndex={index}
									snapshotId={messageSnapshots.get(index)}
									isReverting={isReverting}
									onRevert={handleRevert}
								/>
							))
						)}
						{/* Streaming assistant message (shown while AI is responding) */}
						{streamingContent && streamingContent.length > 0 && <AssistantMessage content={streamingContent} />}
						{/* Continuation prompt — shown when the agent hit the iteration limit */}
						{needsContinuation && !isProcessing && (
							<ContinuationPrompt onContinue={() => void handleSend('continue')} onDismiss={() => setNeedsContinuation(false)} />
						)}
						{/* AI Error display */}
						{aiError && <AIError message={aiError.message} code={aiError.code} onRetry={handleRetry} onDismiss={handleDismissError} />}
						{statusMessage ? (
							<div
								className="
									flex animate-chat-item items-center gap-2 px-1 text-xs
									text-text-secondary
								"
							>
								<Loader2 className="size-3 animate-spin" />
								{statusMessage}
							</div>
						) : undefined}
					</div>
				</ScrollArea.Viewport>
				<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
					<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
				</ScrollArea.Scrollbar>
			</ScrollArea.Root>

			{/* Input */}
			<div className="shrink-0 border-t border-border p-2">
				<div
					className={cn(
						'relative rounded-lg border bg-bg-primary transition-colors',
						'focus-within:border-accent',
						isProcessing ? 'border-warning/40' : 'border-border',
					)}
				>
					{/* File mention autocomplete dropdown */}
					{isFileMentionOpen && (
						<FileMentionDropdown results={fileMentionResults} selectedIndex={fileMentionSelectedIndex} onSelect={selectMentionFile} />
					)}
					<RichTextInput
						ref={inputReference}
						segments={segments}
						onSegmentsChange={setSegments}
						onKeyDown={handleKeyDown}
						onCursorChange={setCursorPosition}
						placeholder={isProcessing ? 'AI is responding...' : 'Ask the AI to help... (@ to mention files)'}
						disabled={isProcessing}
					/>
					<div className="flex items-center justify-between px-1.5 py-1">
						<span className="pl-0.5 text-xs text-text-secondary">
							{isProcessing ? 'Press Stop to cancel' : 'Enter to send · @ to mention files'}
						</span>
						{isProcessing ? (
							<button
								onClick={handleCancel}
								className={cn(
									`
										inline-flex cursor-pointer items-center gap-1.5 rounded-md px-2.5 py-1
									`,
									'text-xs font-medium text-error transition-colors',
									'hover:bg-error/10',
								)}
							>
								<Square className="size-3" />
								Stop
							</button>
						) : (
							<button
								onClick={() => void handleSend()}
								disabled={!hasContent}
								className={cn(
									'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1',
									'text-xs font-medium transition-colors',
									hasContent
										? `
											cursor-pointer bg-accent text-white
											hover:bg-accent-hover
										`
										: 'cursor-not-allowed text-text-secondary opacity-40',
								)}
							>
								<Send className="size-3" />
								Send
							</button>
						)}
					</div>
				</div>
			</div>

			{/* Revert confirmation dialog */}
			{pendingRevert && (
				<RevertConfirmDialog
					open={!!pendingRevert}
					onOpenChange={(open) => {
						if (!open) setPendingRevert(undefined);
					}}
					snapshotId={pendingRevert.snapshotId}
					messageIndex={pendingRevert.messageIndex}
					projectId={projectId}
					onConfirm={handleConfirmRevert}
					isReverting={isReverting}
				/>
			)}
		</div>
	);
}

// =============================================================================
// Welcome Screen
// =============================================================================

function WelcomeScreen({ onSuggestionClick }: { onSuggestionClick: (prompt: string) => void }) {
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
						onClick={() => onSuggestionClick(suggestion.prompt)}
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

function MessageBubble({
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
		<div className="flex animate-chat-item flex-col gap-1">
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

function AssistantMessage({ content }: { content: AgentContent[] }) {
	const segments = buildRenderSegments(content);

	return (
		<div className="flex animate-chat-item flex-col gap-2">
			<div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>
			{segments.map((segment, index) =>
				segment.kind === 'text' ? (
					<div
						key={index}
						className="
							rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed text-text-primary
						"
					>
						<MarkdownContent content={segment.text} />
					</div>
				) : (
					<InlineToolCall key={index} toolUse={segment.toolUse} toolResult={segment.toolResult} />
				),
			)}
		</div>
	);
}

// =============================================================================
// Inline Tool Call
// =============================================================================

/**
 * Parse a tool result string into a brief human-readable summary.
 * Tool results are JSON strings from the server; we extract just
 * enough info to show in the collapsed/expanded view.
 */
function summarizeToolResult(toolName: ToolName, rawResult: string): string {
	try {
		const parsed: unknown = JSON.parse(rawResult);
		if (!isRecord(parsed)) return rawResult.slice(0, 200);

		if (toolName === 'list_files' && Array.isArray(parsed.files)) {
			const files: unknown[] = parsed.files;
			return `${files.length} file${files.length === 1 ? '' : 's'}`;
		}

		if (toolName === 'read_file' && typeof parsed.content === 'string') {
			const lineCount = parsed.content.split('\n').length;
			return `${lineCount} line${lineCount === 1 ? '' : 's'}`;
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

function InlineToolCall({ toolUse, toolResult }: { toolUse: AgentContent; toolResult?: AgentContent }) {
	if (toolUse.type !== 'tool_use') return;

	const toolName = toolUse.name;
	const isCompleted = toolResult !== undefined;
	const isError = toolResult?.type === 'tool_result' && toolResult.is_error;

	// Extract file paths from tool input
	const input = toolUse.input;
	let singlePath: string | undefined;
	let fromPath: string | undefined;
	let toPath: string | undefined;
	if (isRecord(input)) {
		if (typeof input.path === 'string') {
			singlePath = input.path;
		} else if (typeof input.from_path === 'string' && typeof input.to_path === 'string') {
			fromPath = input.from_path;
			toPath = input.to_path;
		}
	}

	// Build summary text for the result
	const resultSummary =
		toolResult?.type === 'tool_result' && typeof toolResult.content === 'string'
			? summarizeToolResult(toolName, toolResult.content)
			: undefined;

	return (
		<div
			className={cn(
				'flex animate-chat-item items-center gap-2 rounded-md px-3 py-1.5 text-xs',
				isCompleted && !isError && 'bg-success/5 text-text-secondary',
				isError && 'bg-error/5 text-error',
				!isCompleted && 'bg-bg-tertiary text-text-secondary',
			)}
		>
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
			{resultSummary && <span className="ml-auto shrink-0 text-text-secondary">{resultSummary}</span>}
		</div>
	);
}

// =============================================================================
// AI Error Component
// =============================================================================

function ContinuationPrompt({ onContinue, onDismiss }: { onContinue: () => void; onDismiss: () => void }) {
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

function AIError({ message, code, onRetry, onDismiss }: { message: string; code?: string; onRetry?: () => void; onDismiss?: () => void }) {
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
