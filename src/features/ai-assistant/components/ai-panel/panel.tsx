/**
 * AI Assistant Panel Component
 *
 * Chat interface for interacting with the AI coding assistant.
 * Uses TanStack AI's useChat + fetchServerSentEvents for native AG-UI streaming.
 *
 * Features: welcome screen with suggestions, collapsible tool calls,
 * collapsible reasoning, error handling with retry, session management,
 * snapshot revert buttons on user messages, CUSTOM event handling.
 */

import { fetchServerSentEvents } from '@tanstack/ai-client';
import { useChat } from '@tanstack/ai-react';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowDown, Bot, ChevronDown, Download, Loader2, Map as MapIcon, Plus, Send, Square } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Pill } from '@/components/ui/pill';
import { setActiveSessionId, useAiSessions } from '@/features/ai-assistant/hooks/use-ai-sessions';
import { getLogSnapshot } from '@/features/output';
import { useSnapshots } from '@/features/snapshots';
import { createApiClient, downloadDebugLog, saveProjectPendingChanges } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';

import { ContextRing } from './context-ring';
import { extractCustomEvent, getNumberField, getStringField } from './helpers';
import { AIError, AssistantMessage, ContinuationPrompt, DoomLoopAlert, MessageBubble, UserQuestionPrompt, WelcomeScreen } from './messages';
import { getModelLabel, getModelLimits } from './model-config';
import { ModelSelectorDialog } from './model-selector-dialog';
import { useAutoScroll } from '../../hooks/use-auto-scroll';
import { useChangeReview } from '../../hooks/use-change-review';
import { useFileMention } from '../../hooks/use-file-mention';
import { parseTextToSegments, segmentsHaveContent, segmentsToPlainText, type InputSegment } from '../../lib/input-segments';
import { extractMessageText } from '../../lib/retry-helpers';
import { pendingChangesMapToRecord } from '../../lib/session-serializers';
import { AgentModeSelector } from '../agent-mode-selector';
import { ChangedFilesSummary } from '../changed-files-summary';
import { FileMentionDropdown } from '../file-mention-dropdown';
import { RevertConfirmDialog } from '../revert-confirm-dialog';
import { RichTextInput, type RichTextInputHandle } from '../rich-text-input';

import type { ToolErrorInfo, ToolMetadataInfo, UIMessage } from '@shared/types';

// =============================================================================
// Component
// =============================================================================

/**
 * AI assistant panel with chat interface.
 */
export function AIPanel({ projectId, className }: { projectId: string; className?: string }) {
	const queryClient = useQueryClient();
	const [segments, setSegments] = useState<InputSegment[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [needsContinuation, setNeedsContinuation] = useState(false);
	const [pendingQuestion, setPendingQuestion] = useState<{ question: string; options: string } | undefined>();
	const [doomLoopMessage, setDoomLoopMessage] = useState<string | undefined>();
	const [planPath, setPlanPath] = useState<string | undefined>();
	const [isModelSelectorOpen, setIsModelSelectorOpen] = useState(false);
	const inputReference = useRef<RichTextInputHandle>(null);
	const userMessageIndexReference = useRef<number>(-1);
	const activeSnapshotIdReference = useRef<string | undefined>(undefined);
	// Track the last chatError we already surfaced so dismissing it doesn't re-trigger
	const lastSurfacedChatErrorReference = useRef<Error | undefined>(undefined);
	// Structured tool error data keyed by toolCallId, populated by CUSTOM tool_error events.
	// Refs accumulate data during streaming (no re-renders); state mirrors are flushed
	// when chatMessages changes so the JSX reads from state, not refs.
	const toolErrorsReference = useRef<Map<string, ToolErrorInfo>>(new Map());
	const [toolErrors, setToolErrors] = useState<Map<string, ToolErrorInfo>>(new Map());
	// Structured tool result metadata keyed by toolCallId, populated by CUSTOM tool_result events.
	const toolMetadataReference = useRef<Map<string, ToolMetadataInfo>>(new Map());
	const [toolMetadata, setToolMetadata] = useState<Map<string, ToolMetadataInfo>>(new Map());
	// Diff content (before/after) keyed by tool_use_id, populated by CUSTOM file_changed events for inline diff rendering
	const fileDiffContentReference = useRef<Map<string, { beforeContent: string; afterContent: string }>>(new Map());
	const [fileDiffContent, setFileDiffContent] = useState<Map<string, { beforeContent: string; afterContent: string }>>(new Map());

	// Derived plain text for the file mention hook
	const inputPlainText = useMemo(() => segmentsToPlainText(segments), [segments]);
	const hasContent = useMemo(() => segmentsHaveContent(segments), [segments]);

	// Revert confirmation dialog state.
	// `snapshotIds` is the full cascade set (from the clicked message forward within the session).
	// `isLoading` and `error` track the revert operation's progress.
	const [pendingRevert, setPendingRevert] = useState<
		{ snapshotIds: string[]; messageIndex: number; isLoading: boolean; error?: string } | undefined
	>();

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
		contextTokensUsed,
		setProcessing,
		setStatusMessage,
		setAiError,
		setMessageSnapshot,
		removeMessagesFrom,
		setAgentMode,
		setSelectedModel,
		setContextTokensUsed,
		openFile,
		addPendingChange,
		associateSnapshotWithPending,
		clearPendingChangesBySnapshots,
		clearPendingChangesByPaths,
		debugLogId,
	} = useStore();

	// Keep stable references for useChat callbacks (avoid re-creating connection)
	const agentModeReference = useRef(agentMode);
	const sessionIdReference = useRef(sessionId);
	const selectedModelReference = useRef(selectedModel);
	useEffect(() => {
		agentModeReference.current = agentMode;
	}, [agentMode]);
	useEffect(() => {
		sessionIdReference.current = sessionId;
	}, [sessionId]);
	useEffect(() => {
		selectedModelReference.current = selectedModel;
	}, [selectedModel]);

	// =========================================================================
	// TanStack AI useChat setup
	// =========================================================================

	const chatUrl = useMemo(() => `/p/${projectId}/api/ai/chat`, [projectId]);

	// Connection adapter — fetchServerSentEvents POSTs { messages, data, ...body }
	// We pass mode, sessionId, model in the body config (read from refs for freshness).
	// The config factory is wrapped in useCallback so refs are read at request time, not render time.
	const connectionConfigFactory = useCallback(
		() => ({
			body: {
				mode: agentModeReference.current,
				sessionId: sessionIdReference.current,
				model: selectedModelReference.current,
				outputLogs: getLogSnapshot(),
			},
		}),
		[],
	);
	// The config factory reads refs at request time (not render time), but ESLint's
	// react-hooks/refs rule cannot distinguish deferred execution from render-time access.
	// eslint-disable-next-line react-hooks/refs -- factory is invoked at fetch time, not render
	const connection = useMemo(() => fetchServerSentEvents(chatUrl, connectionConfigFactory), [chatUrl, connectionConfigFactory]);

	const {
		messages: chatMessages,
		sendMessage,
		isLoading: isChatLoading,
		stop: stopChat,
		error: chatError,
		setMessages: setChatMessages,
		clear: clearChat,
	} = useChat({
		connection,
		initialMessages: history,
		onChunk: (chunk) => {
			const custom = extractCustomEvent(chunk);
			if (!custom) return;

			switch (custom.name) {
				case 'status': {
					const statusText = getStringField(custom.data, 'message');
					if (statusText) {
						setStatusMessage(statusText);
					}
					break;
				}
				case 'snapshot_created': {
					const snapshotId = getStringField(custom.data, 'id');
					if (snapshotId) {
						activeSnapshotIdReference.current = snapshotId;
						if (userMessageIndexReference.current >= 0) {
							setMessageSnapshot(userMessageIndexReference.current, snapshotId);
						}
						associateSnapshotWithPending(snapshotId);
					}
					break;
				}
				case 'file_changed': {
					const path = getStringField(custom.data, 'path');
					const action = getStringField(custom.data, 'action');
					const beforeContent = getStringField(custom.data, 'beforeContent');
					const afterContent = getStringField(custom.data, 'afterContent');
					if (path && (action === 'create' || action === 'edit' || action === 'delete' || action === 'move')) {
						addPendingChange({
							path,
							action,
							beforeContent: beforeContent || undefined,
							afterContent: afterContent || undefined,
							snapshotId: activeSnapshotIdReference.current,
							sessionId: sessionIdReference.current ?? '',
						});
						// Eagerly update the file query cache so the editor shows the
						// correct content immediately.  The WebSocket `update` handler
						// intentionally skips invalidating the *active* file (to avoid
						// racing with unsaved user edits), but AI-driven writes are not
						// user edits — the editor must reflect the new content so that
						// diff decorations (whose hunk positions reference afterContent)
						// align with the actual editor document.
						if (afterContent && action !== 'delete') {
							queryClient.setQueryData(['file', projectId, path], { path, content: afterContent });
						}
						// Store diff content for inline diff rendering in tool call dropdowns
						const toolUseId = getStringField(custom.data, 'tool_use_id');
						if (toolUseId && beforeContent && afterContent) {
							// Cap map size (same pattern as toolErrors)
							if (fileDiffContentReference.current.size >= 500) {
								const firstKey = fileDiffContentReference.current.keys().next().value;
								if (firstKey !== undefined) {
									fileDiffContentReference.current.delete(firstKey);
								}
							}
							fileDiffContentReference.current.set(toolUseId, { beforeContent, afterContent });
						}
						if (action !== 'delete' && action !== 'move') {
							openFile(path);
						}
					}
					break;
				}
				case 'plan_created': {
					const path = getStringField(custom.data, 'path');
					if (path) {
						setPlanPath(path);
					}
					break;
				}
				case 'user_question': {
					const question = getStringField(custom.data, 'question');
					const options = getStringField(custom.data, 'options');
					if (question) {
						setPendingQuestion({ question, options });
					}
					break;
				}
				case 'max_iterations_reached': {
					setNeedsContinuation(true);
					break;
				}
				case 'doom_loop_detected': {
					const message = getStringField(custom.data, 'message');
					if (message) {
						setDoomLoopMessage(message);
					}
					break;
				}
				case 'turn_complete': {
					break;
				}
				case 'context_utilization': {
					// Real-time context window usage emitted per-turn during the agent loop.
					const tokens = getNumberField(custom.data, 'estimatedTokens');
					if (tokens > 0) {
						setContextTokensUsed(tokens);
					}
					break;
				}
				case 'usage': {
					break;
				}
				case 'tool_result': {
					const toolCallId = getStringField(custom.data, 'toolCallId');
					if (toolCallId) {
						if (toolMetadataReference.current.size >= 500) {
							const firstKey = toolMetadataReference.current.keys().next().value;
							if (firstKey !== undefined) {
								toolMetadataReference.current.delete(firstKey);
							}
						}
						const rawMetadata = custom.data.metadata;
						const isPlainObject = (value: unknown): value is Record<string, unknown> =>
							!!value && typeof value === 'object' && !Array.isArray(value);
						const metadataRecord: Record<string, unknown> = isPlainObject(rawMetadata) ? rawMetadata : {};
						toolMetadataReference.current.set(toolCallId, {
							toolCallId,
							toolName: getStringField(custom.data, 'tool_name'),
							title: getStringField(custom.data, 'title'),
							metadata: metadataRecord,
						});
					}
					break;
				}
				case 'tool_error': {
					const toolCallId = getStringField(custom.data, 'toolCallId');
					if (toolCallId) {
						// Cap map size to prevent unbounded growth in long sessions.
						// Only the most recent errors matter for display; old entries
						// for already-rendered messages are harmless to evict.
						if (toolErrorsReference.current.size >= 500) {
							const firstKey = toolErrorsReference.current.keys().next().value;
							if (firstKey !== undefined) {
								toolErrorsReference.current.delete(firstKey);
							}
						}
						toolErrorsReference.current.set(toolCallId, {
							toolCallId,
							toolName: getStringField(custom.data, 'toolName'),
							errorCode: getStringField(custom.data, 'errorCode'),
							errorMessage: getStringField(custom.data, 'errorMessage'),
						});
					}
					break;
				}
			}
		},
		onFinish: (_message) => {
			setProcessing(false);
			setStatusMessage(undefined);
			activeSnapshotIdReference.current = undefined;
			userMessageIndexReference.current = -1;

			// Flush accumulated ref data to state so the final render sees it
			setToolErrors(new Map(toolErrorsReference.current));
			setToolMetadata(new Map(toolMetadataReference.current));
			setFileDiffContent(new Map(fileDiffContentReference.current));

			// If the agent wrote any files, signal the preview to do a hard
			// refresh. The per-file HMR reloads may have hit intermediate
			// states or been lost during iframe reload cycles.
			if (useStore.getState().pendingChanges.size > 0) {
				globalThis.dispatchEvent(new CustomEvent('preview-force-refresh'));
			}

			// Session is persisted server-side — refresh the sessions list so the
			// dropdown reflects the latest state.
			void queryClient.invalidateQueries({ queryKey: ['ai-sessions', projectId] });
		},
		onError: (error) => {
			// Ignore abort errors — the user intentionally cancelled
			if (error.name === 'AbortError') return;
			setProcessing(false);
			setStatusMessage(undefined);
			setAiError({ message: error.message });
			// Flush accumulated ref data to state so the error render sees it
			setToolErrors(new Map(toolErrorsReference.current));
			setToolMetadata(new Map(toolMetadataReference.current));
			setFileDiffContent(new Map(fileDiffContentReference.current));
			// Session is persisted server-side on all termination paths including errors.
		},
	});

	// Bi-directional sync between useChat (chatMessages) and Zustand (history).
	//
	// We use a "skip next" flag to break the circular dependency:
	//   chatMessages changes → forward sync writes to store → store fires
	//   → reverse sync sees change → would call setChatMessages → loop!
	//
	// The flag ensures that when one side writes, the other side's effect
	// recognises it as an echo and skips.
	const skipNextReverseSyncReference = useRef(false);
	const skipNextForwardSyncReference = useRef(false);

	// Forward sync: chatMessages → store
	useEffect(() => {
		if (skipNextForwardSyncReference.current) {
			skipNextForwardSyncReference.current = false;
			return;
		}
		skipNextReverseSyncReference.current = true;
		useStore.setState({ history: chatMessages });
	}, [chatMessages]);

	// Flush accumulated ref data to state on each chatMessages change so that
	// intermediate streaming renders show tool errors, metadata, and diffs without
	// reading refs directly in the JSX (which violates react-hooks/refs).
	useEffect(() => {
		setToolErrors(new Map(toolErrorsReference.current));
		setToolMetadata(new Map(toolMetadataReference.current));
		setFileDiffContent(new Map(fileDiffContentReference.current));
	}, [chatMessages]);

	// Reverse sync: store → chatMessages (for external updates like session load)
	useEffect(() => {
		if (skipNextReverseSyncReference.current) {
			skipNextReverseSyncReference.current = false;
			return;
		}
		skipNextForwardSyncReference.current = true;
		setChatMessages(history);
	}, [history, setChatMessages]);

	// Sync isLoading to isProcessing (both directions for safety)
	useEffect(() => {
		if (isChatLoading && !isProcessing) {
			setProcessing(true);
		} else if (!isChatLoading && isProcessing) {
			setProcessing(false);
			setStatusMessage(undefined);
		}
	}, [isChatLoading, isProcessing, setProcessing, setStatusMessage]);

	// Sync chatError to aiError (for RUN_ERROR events).
	// Only surface a chatError once — if the user dismisses it, don't re-trigger
	// until a genuinely new error arrives from useChat.
	useEffect(() => {
		if (chatError && chatError !== lastSurfacedChatErrorReference.current) {
			lastSurfacedChatErrorReference.current = chatError;
			setAiError({ message: chatError.message });
		}
	}, [chatError, setAiError]);

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
	const { revertCascadeAsync, isReverting } = useSnapshots({ projectId });

	// Change review hook for accept/reject UI
	const changeReview = useChangeReview({ projectId });

	// Wrap clearHistory to start a new session.
	// Pending changes are NOT cleared — they persist across sessions at the project level.
	// clearChat() resets chatMessages to [], which triggers the forward-sync
	// effect to write history=[] to the store. We separately clear the
	// AI-related metadata (sessionId, snapshots, error) to avoid creating a
	// second competing [] reference that would cause a sync loop.
	const clearHistory = useCallback(() => {
		setPlanPath(undefined);
		setNeedsContinuation(false);
		setPendingQuestion(undefined);
		setDoomLoopMessage(undefined);
		toolErrorsReference.current.clear();
		toolMetadataReference.current.clear();
		fileDiffContentReference.current.clear();
		setToolErrors(new Map());
		setToolMetadata(new Map());
		setFileDiffContent(new Map());
		// Clear AI metadata without touching history (the forward sync handles it)
		useStore.setState({
			sessionId: undefined,
			messageSnapshots: new Map(),
			aiError: undefined,
			debugLogId: undefined,
			contextTokensUsed: 0,
		});
		// Clear the project-scoped active session pointer in localStorage
		setActiveSessionId(projectId, undefined);
		// clearChat() must be last — it sets chatMessages=[] which the forward-sync
		// effect will propagate to the store's history.
		clearChat();
	}, [clearChat, projectId]);

	// Wrap handleLoadSession to also clear pending changes and sync to useChat.
	// loadSession updates the store's history, and the reverse-sync effect
	// will propagate that into useChat automatically.
	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			// Note: pendingChanges are NOT cleared here — loadSession() replaces
			// them with the loaded session's persisted pending changes (or empty).
			toolErrorsReference.current.clear();
			toolMetadataReference.current.clear();
			fileDiffContentReference.current.clear();
			setToolErrors(new Map());
			setToolMetadata(new Map());
			setFileDiffContent(new Map());
			loadSession(targetSessionId);
			// Persist the newly loaded session as the active one in localStorage
			setActiveSessionId(projectId, targetSessionId);
		},
		[loadSession, projectId],
	);

	// Smart auto-scroll: stops when user scrolls up, shows pill for new content
	const { scrollReference, anchorReference, canScrollUp, canScrollDown, hasNewContent, scrollToBottom } = useAutoScroll({
		enabled: isChatLoading,
	});

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

			// Clear any previous error, continuation prompt, pending question, or doom loop
			setAiError(undefined);
			setNeedsContinuation(false);
			setPendingQuestion(undefined);
			setDoomLoopMessage(undefined);

			// Eagerly generate a session ID so the server-side persistence always
			// has a valid ID. Update the ref directly so the SSE connection body
			// picks it up immediately (the useEffect sync is deferred).
			if (!sessionIdReference.current) {
				const newId = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
				useStore.getState().setSessionId(newId);
				sessionIdReference.current = newId;
				setActiveSessionId(projectId, newId);
			}

			// Track the index of this user message for snapshot association
			userMessageIndexReference.current = chatMessages.length; // index of the user message about to be added
			setSegments([]);
			inputReference.current?.clear();
			setProcessing(true);
			setStatusMessage('Thinking...');

			try {
				await sendMessage(messageText);
			} catch (error: unknown) {
				if (error instanceof Error && error.name === 'AbortError') {
					// Cancelled — useChat handles partial messages
					return;
				}
				// Other errors are handled by onError callback
			}
		},
		[inputPlainText, isProcessing, chatMessages.length, setAiError, setProcessing, setStatusMessage, sendMessage, projectId],
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
	// Session is persisted server-side when the stream is aborted (via the
	// generator's finally block), so no client-side save is needed here.
	const handleCancel = useCallback(() => {
		stopChat();
		setProcessing(false);
		setStatusMessage(undefined);
	}, [stopChat, setProcessing, setStatusMessage]);

	// Retry last message.
	// We trim messages synchronously via setChatMessages, then defer the re-send
	// to a microtask so useChat has processed the trimmed state before sendMessage runs.
	const handleRetry = useCallback(() => {
		// Find the last user message text
		const lastUserMessage = [...chatMessages].toReversed().find((message) => message.role === 'user');
		if (!lastUserMessage) return;

		const text = extractMessageText(lastUserMessage);

		// Clear the error
		setAiError(undefined);

		// Remove the errored assistant message and/or the last user message to
		// avoid duplicating it when handleSend adds it back.
		const lastMessage = chatMessages.at(-1);
		if (lastMessage && lastMessage.role === 'assistant') {
			// Remove both the assistant reply and the user message before it
			setChatMessages(chatMessages.slice(0, -2));
		} else if (lastMessage && lastMessage.role === 'user') {
			// Error occurred before an assistant message was added — remove the
			// dangling user message so handleSend doesn't duplicate it.
			setChatMessages(chatMessages.slice(0, -1));
		}

		// Defer re-send so useChat processes the trimmed messages first
		queueMicrotask(() => {
			void handleSend(text);
		});
	}, [chatMessages, setAiError, handleSend, setChatMessages]);

	// Dismiss error
	const handleDismissError = useCallback(() => {
		setAiError(undefined);
	}, [setAiError]);

	// Open revert confirmation dialog.
	// Computes the full cascade set: all snapshot IDs from the clicked message forward
	// within the current session, so the dialog can show what will be reverted.
	const handleRevert = useCallback(
		(_snapshotId: string, messageIndex: number) => {
			// Collect snapshot IDs from this message index forward (cascade)
			const cascadeSnapshotIds: string[] = [];
			for (const [index, snapshotId] of messageSnapshots) {
				if (index >= messageIndex) {
					cascadeSnapshotIds.push(snapshotId);
				}
			}

			// Sort by message index descending (newest first) for reverse chronological revert
			const sortedIndices = [...messageSnapshots.entries()].filter(([index]) => index >= messageIndex).toSorted(([a], [b]) => b - a);
			const sortedSnapshotIds = sortedIndices.map(([, id]) => id);

			if (sortedSnapshotIds.length === 0) return;

			setPendingRevert({ snapshotIds: sortedSnapshotIds, messageIndex, isLoading: false });
		},
		[messageSnapshots],
	);

	// Persist updated pending changes to the project-level file after revert.
	const persistPendingChangesAfterRevert = useCallback(async () => {
		const { pendingChanges: currentPendingChanges } = useStore.getState();
		try {
			const record = pendingChangesMapToRecord(currentPendingChanges);
			await saveProjectPendingChanges(projectId, record ?? {});
		} catch (error) {
			console.error('Failed to persist pending changes after revert:', error);
		}
	}, [projectId]);

	// Confirm revert (called from the dialog).
	// Cascade-reverts all snapshots from the clicked message forward within the session,
	// then surgically clears only the affected pending changes.
	const handleConfirmRevert = useCallback(
		async (snapshotIds: string[], messageIndex: number) => {
			// Mark loading state on the dialog
			setPendingRevert((previous) => (previous ? { ...previous, isLoading: true, error: undefined } : previous));

			// Cancel any ongoing generation first
			if (isProcessing) {
				stopChat();
				setProcessing(false);
				setStatusMessage(undefined);
			}

			// Extract the user prompt text before removing messages
			const userMessage = chatMessages[messageIndex];
			const promptText = userMessage ? extractMessageText(userMessage) : '';

			try {
				const result = await revertCascadeAsync(snapshotIds);

				// Build the set of successfully reverted file paths
				const revertedPaths = new Set(result.reverted.map((file) => file.path));

				// For files that failed to revert on the backend, attempt a fallback:
				// use beforeContent from pending changes to restore the original file.
				const { pendingChanges: currentPendingChanges } = useStore.getState();
				const apiClient = createApiClient(projectId);
				for (const failed of result.failed) {
					const change = currentPendingChanges.get(failed.path);
					if (change?.beforeContent !== undefined && change.action === 'edit') {
						try {
							await apiClient.file.$put({ json: { path: failed.path, content: change.beforeContent } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback revert failed for ${failed.path}`);
						}
					} else if (change?.action === 'create') {
						try {
							await apiClient.file.$delete({ query: { path: failed.path } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback delete failed for ${failed.path}`);
						}
					}
				}

				// Surgically clear only the pending changes for reverted files
				clearPendingChangesByPaths(revertedPaths);

				// Also clear any remaining pending changes whose snapshotId is in the cascade set
				// (covers entries that may not have a file path match, e.g., deleted files)
				const snapshotIdSet = new Set(snapshotIds);
				clearPendingChangesBySnapshots(snapshotIdSet);

				// Remove the user message and all subsequent messages, clean up snapshot associations
				removeMessagesFrom(messageIndex);

				// Sync to useChat
				setChatMessages(chatMessages.slice(0, messageIndex));

				// Restore the prompt text into the input, parsing file mentions back into pills
				if (promptText) {
					const knownPaths = new Set(files.map((file) => file.path));
					setSegments(parseTextToSegments(promptText, knownPaths));
					requestAnimationFrame(() => {
						inputReference.current?.focus();
					});
				}

				// Persist the updated pending changes and session.
				// Pass `revertedAt` so the server-side `persistSession` (which may
				// still fire from the cancelled stream's `finally` block) knows not
				// to overwrite the truncated history with the pre-revert version.
				const revertedAt = Date.now();
				queueMicrotask(() => {
					void persistPendingChangesAfterRevert();
					void saveCurrentSession({ revertedAt });
				});

				// Close the dialog on success
				setPendingRevert(undefined);

				// Warn if there were missing snapshots that couldn't be found
				if (result.missingSnapshots.length > 0) {
					console.warn('Some snapshots were not found during cascade revert:', result.missingSnapshots);
				}
			} catch (error) {
				// Show error in the dialog — don't close it, let the user retry or cancel
				const message = error instanceof Error ? error.message : 'Failed to revert changes';
				setPendingRevert((previous) => (previous ? { ...previous, isLoading: false, error: message } : previous));
			}
		},
		[
			isProcessing,
			chatMessages,
			projectId,
			files,
			stopChat,
			setProcessing,
			setStatusMessage,
			revertCascadeAsync,
			clearPendingChangesByPaths,
			clearPendingChangesBySnapshots,
			removeMessagesFrom,
			setChatMessages,
			persistPendingChangesAfterRevert,
			saveCurrentSession,
		],
	);

	// Download debug log
	const handleDownloadDebugLog = useCallback(() => {
		if (!debugLogId) return;
		void downloadDebugLog(projectId, debugLogId, sessionId).catch((error) => {
			console.error('Failed to download debug log:', error);
		});
	}, [debugLogId, projectId, sessionId]);

	// Handle suggestion click
	const handleSuggestion = useCallback(
		(prompt: string) => {
			void handleSend(prompt);
		},
		[handleSend],
	);

	// Determine the streaming assistant message (last message if it's still being generated)
	const streamingAssistantMessage = useMemo((): UIMessage | undefined => {
		if (!isChatLoading) return undefined;
		const last = chatMessages.at(-1);
		if (last && last.role === 'assistant' && last.parts.length > 0) {
			return last;
		}
		return undefined;
	}, [isChatLoading, chatMessages]);

	// Non-streaming messages (all except the streaming one)
	const displayMessages = useMemo(() => {
		if (streamingAssistantMessage) {
			return chatMessages.slice(0, -1);
		}
		return chatMessages;
	}, [chatMessages, streamingAssistantMessage]);

	return (
		<div className={cn('flex h-full flex-col bg-bg-secondary', className)}>
			{/* Header */}
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex min-w-0 items-center gap-2 overflow-hidden">
					<Bot className="size-4 shrink-0 text-accent" />
					<span className="truncate text-xs font-medium text-text-secondary">Agent</span>
					<Pill color="muted" size="xs" className="shrink-0">
						Beta
					</Pill>
				</div>
				<div className="flex shrink-0 items-center gap-1">
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
					{chatMessages.length > 0 && (
						<Button variant="ghost" size="icon-sm" onClick={clearHistory} title="New session">
							<Plus className="size-3.5" />
						</Button>
					)}
				</div>
			</div>

			{/* Messages — with fade edges and smart auto-scroll */}
			<div className="relative flex-1 overflow-hidden">
				{/* Top fade edge */}
				<div
					className={cn(
						'pointer-events-none absolute inset-x-0 top-0 z-10 h-6',
						'bg-linear-to-b from-bg-secondary to-transparent',
						'transition-opacity duration-200',
						canScrollUp ? 'opacity-100' : 'opacity-0',
					)}
				/>

				<ScrollArea.Root className="size-full">
					<ScrollArea.Viewport ref={scrollReference} className="size-full [&>div]:block!">
						<div className="flex min-w-0 flex-col gap-3 p-2">
							{displayMessages.length === 0 && !streamingAssistantMessage ? (
								<WelcomeScreen onSuggestionClick={handleSuggestion} onModeChange={setAgentMode} />
							) : (
								<>
									{displayMessages.map((message, index) => (
										<MessageBubble
											key={message.id}
											message={message}
											messageIndex={index}
											snapshotId={messageSnapshots.get(index)}
											isReverting={isReverting}
											revertingMessageIndex={pendingRevert?.isLoading ? pendingRevert.messageIndex : undefined}
											onRevert={handleRevert}
											toolErrors={toolErrors}
											toolMetadata={toolMetadata}
											fileDiffContent={fileDiffContent}
										/>
									))}
								</>
							)}
							{/* Streaming assistant message */}
							{streamingAssistantMessage && (
								<AssistantMessage
									message={streamingAssistantMessage}
									streaming
									toolErrors={toolErrors}
									toolMetadata={toolMetadata}
									fileDiffContent={fileDiffContent}
								/>
							)}
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
							{/* Doom loop alert — shown when the agent was stopped due to repetitive behavior */}
							{doomLoopMessage && !isProcessing && (
								<DoomLoopAlert message={doomLoopMessage} onRetry={handleRetry} onDismiss={() => setDoomLoopMessage(undefined)} />
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
							{/* Invisible anchor for auto-scroll detection */}
							<div ref={anchorReference} className="h-px shrink-0" aria-hidden />
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>

				{/* Bottom fade edge */}
				<div
					className={cn(
						'pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6',
						'bg-linear-to-t from-bg-secondary to-transparent',
						'transition-opacity duration-200',
						canScrollDown ? 'opacity-100' : 'opacity-0',
					)}
				/>

				{/* Floating "new content" pill */}
				{hasNewContent && (
					<button
						type="button"
						onClick={scrollToBottom}
						className={cn(
							'absolute bottom-3 left-1/2 z-20 -translate-x-1/2',
							'flex cursor-pointer items-center gap-1.5 rounded-full',
							'border border-border bg-bg-primary px-3 py-1.5',
							'text-xs font-medium text-accent shadow-md',
							'animate-chat-item transition-colors',
							'hover:bg-bg-tertiary',
						)}
					>
						<ArrowDown className="size-3" />
						Follow along
					</button>
				)}
			</div>

			{/* Changed files summary — shown when AI has pending edits */}
			<Collapsible open={changeReview.sessionPendingCount(sessionId) > 0} className="shrink-0 overflow-hidden">
				<div className="border-t border-border px-2 pt-2">
					<ChangedFilesSummary
						onApproveChange={changeReview.handleApproveChange}
						onRejectChange={changeReview.handleRejectChange}
						onApproveAll={() => changeReview.handleApproveAll(sessionId)}
						onRejectAll={() => changeReview.handleRejectAll(sessionId)}
						isReverting={changeReview.isReverting}
						canReject={changeReview.canReject}
						sessionId={sessionId}
					/>
				</div>
			</Collapsible>

			{/* Input */}
			<div className="shrink-0 overflow-hidden border-t border-border p-2">
				<div
					className={cn(
						`
							relative overflow-hidden rounded-lg border bg-bg-primary
							transition-colors
						`,
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
					<Collapsible open={!!planPath}>
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
					</Collapsible>
					<div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 px-1.5 py-1">
						<AgentModeSelector mode={agentMode} onModeChange={setAgentMode} disabled={isProcessing} />
						<Pill
							size="md"
							color="muted"
							className={cn(
								'max-w-full min-w-0 cursor-pointer overflow-hidden transition-colors',
								isProcessing && 'cursor-not-allowed opacity-40',
							)}
							onClick={() => !isProcessing && setIsModelSelectorOpen(true)}
						>
							<span className="truncate">{getModelLabel(selectedModel)}</span>
						</Pill>
						<ContextRing tokensUsed={contextTokensUsed} contextWindow={getModelLimits(selectedModel).contextWindow} />
						<div className="ml-auto flex shrink-0 items-center gap-1">
							{debugLogId && (
								<button
									onClick={handleDownloadDebugLog}
									className={cn(
										'inline-flex cursor-pointer items-center gap-1.5 rounded-md p-1.5',
										'text-xs text-text-secondary transition-colors',
										'hover:bg-bg-tertiary hover:text-text-primary',
									)}
									title="Download debug log"
								>
									<Download className="size-3" />
								</button>
							)}
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
			</div>

			{/* Revert confirmation dialog */}
			{pendingRevert && (
				<RevertConfirmDialog
					open={!!pendingRevert}
					onOpenChange={(open) => {
						if (!open && !pendingRevert.isLoading) setPendingRevert(undefined);
					}}
					snapshotIds={pendingRevert.snapshotIds}
					messageIndex={pendingRevert.messageIndex}
					projectId={projectId}
					onConfirm={handleConfirmRevert}
					isReverting={pendingRevert.isLoading}
					revertError={pendingRevert.error}
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
