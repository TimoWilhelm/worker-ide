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
import { useCallback, useEffect, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { useSnapshots } from '@/features/snapshots';
import { startAIChat, type AIStreamEvent } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

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

function escapeHtml(string_: string): string {
	return string_.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

function formatAiText(content: string): string {
	let html = escapeHtml(content);

	// Code blocks
	html = html.replaceAll(/```(\w*)\n([\s\S]*?)```/g, (_match, _language, code) => {
		return `<pre class="ai-code-block"><code>${code.trim()}</code></pre>`;
	});

	// Inline code
	html = html.replaceAll(/`([^`]+)`/g, '<code class="ai-inline-code">$1</code>');

	// Bold
	html = html.replaceAll(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

	// Italic
	html = html.replaceAll(/\*([^*]+)\*/g, '<em>$1</em>');

	// Line breaks
	html = html.replaceAll('\n', '<br>');

	return html;
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
	const [input, setInput] = useState('');
	const inputReference = useRef<HTMLTextAreaElement>(null);
	const scrollReference = useRef<HTMLDivElement>(null);
	const abortControllerReference = useRef<AbortController | undefined>(undefined);
	const assistantContentReference = useRef<AgentContent[]>([]);
	const userMessageIndexReference = useRef<number>(-1);

	// Store state
	const {
		history,
		isProcessing,
		statusMessage,
		aiError,
		savedSessions,
		sessionId,
		messageSnapshots,
		addMessage,
		clearHistory,
		loadSession,
		setProcessing,
		setStatusMessage,
		setAiError,
		setMessageSnapshot,
		removeMessagesAfter,
	} = useStore();

	// Snapshot hook for revert
	const { revertSnapshot, isReverting } = useSnapshots({ projectId });

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [history, statusMessage, aiError]);

	// Focus input on mount
	useEffect(() => {
		inputReference.current?.focus();
	}, []);

	// Send message
	const handleSend = useCallback(
		async (messageOverride?: string) => {
			const messageText = messageOverride ?? input.trim();
			if (!messageText || isProcessing) return;

			// Clear any previous error
			setAiError(undefined);

			const userMessage: AgentMessage = {
				role: 'user',
				content: [{ type: 'text', text: messageText }],
			};

			addMessage(userMessage);
			// Track the index of this user message for snapshot association
			userMessageIndexReference.current = history.length; // index of the user message we just added
			setInput('');
			setProcessing(true);
			setStatusMessage('Thinking...');

			// Create abort controller for cancellation
			abortControllerReference.current = new AbortController();

			const assistantContent: AgentContent[] = [];
			assistantContentReference.current = assistantContent;
			let wasCancelled = false;

			try {
				// Convert history to API format
				const apiHistory = history.map((message) => ({
					role: message.role,
					content: message.content,
				}));

				await startAIChat(projectId, messageText, apiHistory, abortControllerReference.current.signal, (event: AIStreamEvent) => {
					switch (event.type) {
						case 'content_block_start': {
							// New content block starting
							break;
						}
						case 'content_block_delta': {
							if (event.delta && typeof event.delta === 'object' && 'text' in event.delta) {
								const delta = event.delta;
								const textValue = 'text' in delta ? delta.text : undefined;
								const deltaText = typeof textValue === 'string' ? textValue : '';
								// Accumulate text
								const lastContent = assistantContent.at(-1);
								if (lastContent && lastContent.type === 'text') {
									lastContent.text += deltaText;
								} else {
									assistantContent.push({ type: 'text', text: deltaText });
								}
								setStatusMessage(undefined);
							}
							break;
						}
						case 'tool_use': {
							// Tool being used
							const toolName = getEventToolName(event, 'name');
							setStatusMessage(`Using tool: ${toolName}`);
							assistantContent.push({
								type: 'tool_use',
								id: getEventStringField(event, 'id'),
								name: toolName,
								input: getEventObjectField(event, 'input'),
							});
							break;
						}
						case 'tool_result': {
							assistantContent.push({
								type: 'tool_result',
								tool_use_id: getEventStringField(event, 'tool_use_id'),
								content: getEventStringField(event, 'content'),
								is_error: getEventBooleanField(event, 'is_error'),
							});
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
						case 'message_stop': {
							// Message complete
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
				abortControllerReference.current = undefined;
				assistantContentReference.current = [];
				if (!wasCancelled) {
					userMessageIndexReference.current = -1;
				}
			}
		},
		[input, isProcessing, history, projectId, addMessage, setProcessing, setStatusMessage, setAiError, setMessageSnapshot],
	);

	// Handle keyboard shortcuts
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				void handleSend();
			}
		},
		[handleSend],
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

	// Revert to a snapshot (from a user message)
	const handleRevert = useCallback(
		(snapshotId: string) => {
			// Cancel any ongoing generation first
			if (isProcessing) {
				abortControllerReference.current?.abort();
			}
			revertSnapshot(snapshotId);
		},
		[isProcessing, revertSnapshot],
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
									<DropdownMenuItem
										key={session.id}
										onSelect={() => loadSession([], session.id)}
										className={cn(sessionId === session.id && 'bg-bg-tertiary')}
									>
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
						{/* AI Error display */}
						{aiError && <AIError message={aiError.message} code={aiError.code} onRetry={handleRetry} onDismiss={handleDismissError} />}
						{statusMessage ? (
							<div className="flex items-center gap-2 px-1 text-xs text-text-secondary">
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
						'overflow-hidden rounded-lg border bg-bg-primary transition-colors',
						'focus-within:border-accent',
						isProcessing ? 'border-warning/40' : 'border-border',
					)}
				>
					<textarea
						ref={inputReference}
						value={input}
						onChange={(event) => setInput(event.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={isProcessing ? 'AI is responding...' : 'Ask the AI to help...'}
						className={cn(
							'block w-full resize-none bg-transparent px-2.5 pt-2 pb-0',
							'text-sm/relaxed text-text-primary',
							'placeholder:text-text-secondary',
							`
								focus:outline-none
								focus-visible:outline-none
							`,
							'disabled:opacity-50',
						)}
						rows={2}
						disabled={isProcessing}
					/>
					<div className="flex items-center justify-between px-1.5 py-1">
						<span className="pl-0.5 text-xs text-text-secondary">{isProcessing ? 'Press Stop to cancel' : 'Enter to send'}</span>
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
								disabled={!input.trim()}
								className={cn(
									'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1',
									'text-xs font-medium transition-colors',
									input.trim()
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
	snapshotId,
	isReverting,
	onRevert,
}: {
	message: AgentMessage;
	messageIndex: number;
	snapshotId?: string;
	isReverting: boolean;
	onRevert: (snapshotId: string) => void;
}) {
	const isUser = message.role === 'user';

	// Separate text content from tool content
	const textBlocks: AgentContent[] = [];
	const toolBlocks: AgentContent[] = [];

	for (const block of message.content) {
		if (block.type === 'text') {
			textBlocks.push(block);
		} else {
			toolBlocks.push(block);
		}
	}

	if (isUser) {
		return <UserMessage content={textBlocks} snapshotId={snapshotId} isReverting={isReverting} onRevert={onRevert} />;
	}

	return <AssistantMessage textBlocks={textBlocks} toolBlocks={toolBlocks} />;
}

// =============================================================================
// User Message
// =============================================================================

function UserMessage({
	content,
	snapshotId,
	isReverting,
	onRevert,
}: {
	content: AgentContent[];
	snapshotId?: string;
	isReverting: boolean;
	onRevert: (snapshotId: string) => void;
}) {
	const text = content
		.filter((block): block is AgentContent & { type: 'text' } => block.type === 'text')
		.map((block) => block.text)
		.join('\n');

	return (
		<div className="flex flex-col gap-1">
			<div className="flex items-center justify-between">
				<div className="text-2xs font-semibold tracking-wider text-accent uppercase">You</div>
				{snapshotId && (
					<Tooltip content="Revert files to before this message">
						<button
							onClick={() => onRevert(snapshotId)}
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
				<span className="whitespace-pre-wrap">{text}</span>
			</div>
		</div>
	);
}

// =============================================================================
// Assistant Message
// =============================================================================

function AssistantMessage({ textBlocks, toolBlocks }: { textBlocks: AgentContent[]; toolBlocks: AgentContent[] }) {
	const hasTools = toolBlocks.length > 0;
	const text = textBlocks
		.filter((block): block is AgentContent & { type: 'text' } => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
		.trim();

	// Pair tool_use with their tool_result
	const toolPairs: Array<{ toolUse: AgentContent; toolResult?: AgentContent }> = [];
	for (const block of toolBlocks) {
		if (block.type === 'tool_use') {
			toolPairs.push({ toolUse: block });
		} else if (block.type === 'tool_result') {
			// Find the matching tool_use
			const matching = toolPairs.find(
				(pair) => !pair.toolResult && pair.toolUse.type === 'tool_use' && pair.toolUse.id === block.tool_use_id,
			);
			if (matching) {
				matching.toolResult = block;
			}
		}
	}

	return (
		<div className="flex flex-col gap-2">
			<div className="text-2xs font-semibold tracking-wider text-success uppercase">AI</div>

			{/* Text before tool calls - collapsible if tools follow */}
			{text && hasTools && <CollapsibleReasoning text={text} />}

			{/* Tool calls */}
			{toolPairs.map((pair, index) => (
				<InlineToolCall key={index} toolUse={pair.toolUse} toolResult={pair.toolResult} />
			))}

			{/* Final text (no tools, or text after tools) */}
			{text && !hasTools && (
				<div
					className={cn(`
						rounded-lg bg-bg-tertiary px-3 py-2.5 text-sm/relaxed
						text-text-primary
					`)}
					dangerouslySetInnerHTML={{ __html: formatAiText(text) }}
				/>
			)}
		</div>
	);
}

// =============================================================================
// Collapsible Reasoning
// =============================================================================

function CollapsibleReasoning({ text }: { text: string }) {
	const [isExpanded, setIsExpanded] = useState(false);

	return (
		<div className="overflow-hidden rounded-md border border-border bg-bg-primary">
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				className={cn(
					`
						flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-xs
						text-text-secondary
					`,
					`
						transition-colors
						hover:bg-bg-tertiary
					`,
				)}
			>
				<ChevronDown className={cn('size-3 transition-transform', !isExpanded && '-rotate-90')} />
				<span className="font-medium">Show reasoning</span>
			</button>
			{isExpanded && (
				<div
					className={cn(`
						border-t border-border px-3 py-2 text-sm/relaxed text-text-primary
					`)}
					dangerouslySetInnerHTML={{ __html: formatAiText(text) }}
				/>
			)}
		</div>
	);
}

// =============================================================================
// Inline Tool Call
// =============================================================================

function InlineToolCall({ toolUse, toolResult }: { toolUse: AgentContent; toolResult?: AgentContent }) {
	const [isExpanded, setIsExpanded] = useState(false);

	if (toolUse.type !== 'tool_use') return;

	const toolName = toolUse.name;
	const isCompleted = toolResult !== undefined;
	const isError = toolResult?.type === 'tool_result' && toolResult.is_error;

	// Extract file path from tool input
	const input = toolUse.input;
	let details = '';
	if (isRecord(input)) {
		if (typeof input.path === 'string') {
			details = input.path;
		} else if (typeof input.from_path === 'string' && typeof input.to_path === 'string') {
			details = `${input.from_path} → ${input.to_path}`;
		}
	}

	// Determine change type for the result summary
	let changeAction = '';
	switch (toolName) {
		case 'write_file': {
			changeAction = 'Modified';
			break;
		}
		case 'delete_file': {
			changeAction = 'Deleted';
			break;
		}
		case 'read_file': {
			changeAction = 'Read';
			break;
		}
		case 'list_files': {
			changeAction = 'Listed files';
			break;
		}
		case 'move_file': {
			{
				changeAction = 'Moved';
				// No default
			}
			break;
		}
	}

	return (
		<div
			className={cn(
				`
					overflow-hidden rounded-md border border-border bg-bg-primary
					transition-colors
				`,
				isCompleted && !isError && 'border-success/30',
				isError && 'border-error/30',
			)}
		>
			<button
				onClick={() => setIsExpanded(!isExpanded)}
				className={cn(
					`
						flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left text-xs
						text-text-secondary
					`,
					`
						transition-colors
						hover:bg-bg-tertiary
					`,
				)}
			>
				<span className={cn(isCompleted && !isError && 'text-success', isError && 'text-error')}>
					<ToolIcon name={toolName} />
				</span>
				<span className="text-xs font-semibold capitalize">{toolName.replaceAll('_', ' ')}</span>
				{details && <span className="min-w-0 truncate font-mono text-xs text-accent">{details}</span>}
				<ChevronDown className={cn('ml-auto size-3 shrink-0 opacity-40 transition-transform', isExpanded && 'rotate-180')} />
			</button>
			{isExpanded && (
				<div className="border-t border-border px-3 py-2">
					{isCompleted && (
						<div
							className={cn(
								'font-mono text-xs',
								isError
									? 'text-error'
									: toolName === 'delete_file'
										? 'text-error'
										: toolName === 'write_file'
											? 'text-warning'
											: 'text-text-secondary',
							)}
						>
							{changeAction} {details}
						</div>
					)}
					{toolResult?.type === 'tool_result' && toolResult.content && (
						<pre className="mt-1 max-h-32 overflow-auto text-xs text-text-secondary">
							{typeof toolResult.content === 'string'
								? toolResult.content.length > 500
									? toolResult.content.slice(0, 500) + '...'
									: toolResult.content
								: JSON.stringify(toolResult.content, undefined, 2)}
						</pre>
					)}
				</div>
			)}
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
				'flex flex-col gap-2.5 rounded-lg border p-3',
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
