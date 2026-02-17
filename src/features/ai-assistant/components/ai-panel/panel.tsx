/**
 * AI Assistant Panel Component
 *
 * Chat interface for interacting with the AI coding assistant.
 * Features: welcome screen with suggestions, collapsible tool calls,
 * collapsible reasoning, error handling with retry, session management,
 * snapshot revert buttons on user messages.
 */

import { Bot, ChevronDown, Loader2, Map as MapIcon, Plus, Send, Square } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill } from '@/components/ui/pill';
import { Tooltip } from '@/components/ui/tooltip';
import { useSnapshots } from '@/features/snapshots';
import { startAIChat, type AIStreamEvent } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import { getEventBooleanField, getEventObjectField, getEventStringField, getEventToolName } from './helpers';
import { AIError, AssistantMessage, ContinuationPrompt, MessageBubble, UserQuestionPrompt, WelcomeScreen } from './messages';
import { getModelLabel } from './model-config';
import { ModelSelectorDialog } from './model-selector-dialog';
import { useAiSessions } from '../../hooks/use-ai-sessions';
import { useChangeReview } from '../../hooks/use-change-review';
import { useFileMention } from '../../hooks/use-file-mention';
import { segmentsHaveContent, segmentsToPlainText, type InputSegment } from '../../lib/input-segments';
import { AgentModeSelector } from '../agent-mode-selector';
import { ChangedFilesSummary } from '../changed-files-summary';
import { FileMentionDropdown } from '../file-mention-dropdown';
import { RevertConfirmDialog } from '../revert-confirm-dialog';
import { RichTextInput, type RichTextInputHandle } from '../rich-text-input';

import type { AgentContent, AgentMessage } from '@shared/types';

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
	const [pendingQuestion, setPendingQuestion] = useState<{ question: string; options: string } | undefined>();
	const [planPath, setPlanPath] = useState<string | undefined>();
	const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
	const inputReference = useRef<RichTextInputHandle>(null);
	const scrollReference = useRef<HTMLDivElement>(null);
	const abortControllerReference = useRef<AbortController | undefined>(undefined);
	const assistantContentReference = useRef<AgentContent[]>([]);
	const userMessageIndexReference = useRef<number>(-1);
	const activeSnapshotIdReference = useRef<string | undefined>(undefined);

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
		agentMode,
		sessionId,
		selectedModel,
		addMessage,
		clearHistory: storeClearHistory,
		setProcessing,
		setStatusMessage,
		setAiError,
		setMessageSnapshot,
		removeMessagesAfter,
		removeMessagesFrom,
		setAgentMode,
		setSelectedModel,
		openFile,
		addPendingChange,
		associateSnapshotWithPending,
		clearPendingChanges,
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
	const { savedSessions, handleLoadSession: loadSession, saveCurrentSession } = useAiSessions({ projectId });

	// Snapshot hook for revert
	const { revertSnapshotAsync, isReverting } = useSnapshots({ projectId });

	// Change review hook for accept/reject UI
	const changeReview = useChangeReview({ projectId });

	// Wrap clearHistory to also clear pending changes
	const clearHistory = useCallback(() => {
		storeClearHistory();
		clearPendingChanges();
	}, [storeClearHistory, clearPendingChanges]);

	// Wrap handleLoadSession to also clear pending changes
	const handleLoadSession = useCallback(
		(sessionId: string) => {
			clearPendingChanges();
			loadSession(sessionId);
		},
		[clearPendingChanges, loadSession],
	);

	// Auto-scroll to bottom
	useEffect(() => {
		if (scrollReference.current) {
			scrollReference.current.scrollTop = scrollReference.current.scrollHeight;
		}
	}, [history, statusMessage, aiError, streamingContent, needsContinuation, pendingQuestion]);

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

			// Clear any previous error, continuation prompt, or pending question
			setAiError(undefined);
			setNeedsContinuation(false);
			setPendingQuestion(undefined);

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

				await startAIChat(
					projectId,
					messageText,
					apiHistory,
					abortControllerReference.current.signal,
					(event: AIStreamEvent) => {
						switch (event.type) {
							case 'plan_created': {
								const path = getEventStringField(event, 'path');
								if (path) {
									setPlanPath(path);
								}
								break;
							}
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
								// Snapshot is created eagerly at prompt submission.
								// Store the ID so subsequent file_changed events can
								// associate directly with this snapshot.
								const snapshotId = getEventStringField(event, 'id');
								if (snapshotId) {
									activeSnapshotIdReference.current = snapshotId;
									if (userMessageIndexReference.current >= 0) {
										setMessageSnapshot(userMessageIndexReference.current, snapshotId);
									}
									// Link any already-pending changes (e.g. from a previous turn)
									associateSnapshotWithPending(snapshotId);
								}
								break;
							}
							case 'file_changed': {
								const path = getEventStringField(event, 'path');
								const action = getEventStringField(event, 'action');
								const beforeContent = getEventStringField(event, 'beforeContent');
								const afterContent = getEventStringField(event, 'afterContent');
								if (path && (action === 'create' || action === 'edit' || action === 'delete' || action === 'move')) {
									addPendingChange({
										path,
										action,
										beforeContent: beforeContent || undefined,
										afterContent: afterContent || undefined,
										snapshotId: activeSnapshotIdReference.current,
									});
									// Open the file so the user sees the diff immediately
									// (skip for deletes — the file no longer exists on disk)
									// (skip for moves — the path is "from → to", not a real file)
									if (action !== 'delete' && action !== 'move') {
										openFile(path);
									}
								}
								break;
							}
							case 'user_question': {
								const question = getEventStringField(event, 'question');
								const options = getEventStringField(event, 'options');
								if (question) {
									setPendingQuestion({ question, options });
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
					},
					{ mode: agentMode, sessionId, model: selectedModel },
				);

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
				activeSnapshotIdReference.current = undefined;
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
			agentMode,
			sessionId,
			selectedModel,
			addMessage,
			setProcessing,
			setStatusMessage,
			setAiError,
			setMessageSnapshot,
			saveCurrentSession,
			addPendingChange,
			associateSnapshotWithPending,
			openFile,
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

		// Remove the errored assistant message and/or the last user message to
		// avoid duplicating it when handleSend adds it back.
		const lastMessage = history.at(-1);
		if (lastMessage && lastMessage.role === 'assistant') {
			// Remove both the assistant reply and the user message before it
			removeMessagesAfter(history.length - 2);
		} else if (lastMessage && lastMessage.role === 'user') {
			// Error occurred before an assistant message was added — remove the
			// dangling user message so handleSend doesn't duplicate it.
			removeMessagesAfter(history.length - 1);
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

				// Clear all pending changes since files are restored
				clearPendingChanges();

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
		[isProcessing, history, revertSnapshotAsync, removeMessagesFrom, clearPendingChanges, saveCurrentSession],
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
						<DropdownMenuContent align="end" className="max-h-80 w-56 overflow-y-auto">
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
				<ScrollArea.Viewport ref={scrollReference} className="size-full [&>div]:block!">
					<div className="flex min-w-0 flex-col gap-3 p-2">
						{history.length === 0 ? (
							<WelcomeScreen onSuggestionClick={handleSuggestion} onModeChange={setAgentMode} />
						) : (
							<>
								{history.map((message, index) => (
									<MessageBubble
										key={index}
										message={message}
										messageIndex={index}
										snapshotId={messageSnapshots.get(index)}
										isReverting={isReverting}
										onRevert={handleRevert}
									/>
								))}
							</>
						)}
						{/* Streaming assistant message */}
						{streamingContent && streamingContent.length > 0 && <AssistantMessage content={streamingContent} streaming />}
						{/* User question prompt — shown when the AI asks a clarifying question */}
						{pendingQuestion && !isProcessing && (
							<UserQuestionPrompt
								question={pendingQuestion.question}
								options={pendingQuestion.options}
								onOptionClick={(option) => void handleSend(option)}
							/>
						)}
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

			{/* Changed files summary — shown when AI has pending edits */}
			{changeReview.pendingCount > 0 && (
				<div className="shrink-0 border-t border-border px-2 pt-2">
					<ChangedFilesSummary
						onApproveChange={changeReview.handleApproveChange}
						onRejectChange={changeReview.handleRejectChange}
						onApproveAll={changeReview.handleApproveAll}
						onRejectAll={changeReview.handleRejectAll}
						isReverting={changeReview.isReverting}
						canReject={changeReview.canReject}
					/>
				</div>
			)}

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
						placeholder={
							isProcessing
								? 'AI is responding...'
								: agentMode === 'plan'
									? 'Describe what to plan...'
									: agentMode === 'ask'
										? 'Ask a question...'
										: 'Ask the AI to help...'
						}
						disabled={isProcessing}
					/>
					{planPath && (
						<button
							onClick={() => openFile(planPath)}
							className="
								flex w-full items-center gap-1.5 border-t border-border/50 px-2.5 py-1
								text-xs text-accent transition-colors
								hover:bg-accent/5
							"
						>
							<MapIcon className="size-3 shrink-0" />
							<span className="truncate">View plan: {planPath.split('/').pop()}</span>
						</button>
					)}
					<div className="flex items-center justify-between px-1.5 py-1">
						<div className="flex items-center gap-2">
							<AgentModeSelector mode={agentMode} onModeChange={setAgentMode} disabled={isProcessing} />
							<Pill
								size="md"
								color="muted"
								className={cn('cursor-pointer transition-colors', isProcessing && 'cursor-not-allowed opacity-40')}
								onClick={() => !isProcessing && setIsModelSelectorOpen(true)}
							>
								{getModelLabel(selectedModel)}
							</Pill>
						</div>
						{isProcessing ? (
							<button
								onClick={handleCancel}
								className={cn(
									`inline-flex cursor-pointer items-center gap-1.5 rounded-md p-1.5`,
									'text-xs font-medium text-error transition-colors',
									'hover:bg-error/10',
								)}
								aria-label="Stop"
							>
								<Square className="size-3" />
							</button>
						) : (
							<button
								onClick={() => void handleSend()}
								disabled={!hasContent}
								className={cn(
									'inline-flex items-center gap-1.5 rounded-md p-1.5',
									'text-xs font-medium transition-colors',
									hasContent
										? `
											cursor-pointer bg-accent text-white
											hover:bg-accent-hover
										`
										: 'cursor-not-allowed text-text-secondary opacity-40',
								)}
								aria-label="Send"
							>
								<Send className="size-3" />
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

			{/* Model selector dialog */}
			<ModelSelectorDialog
				open={isModelSelectorOpen}
				onOpenChange={setIsModelSelectorOpen}
				selectedModel={selectedModel}
				onSelectModel={setSelectedModel}
			/>
		</div>
	);
}
