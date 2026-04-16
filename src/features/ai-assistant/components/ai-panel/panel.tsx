/**
 * AI Agent Panel Component
 *
 * Chat interface for interacting with the AI coding assistant.
 * Uses useAgentChat hook for server-driven streaming via the AgentRunner DO.
 *
 * Features: welcome screen with suggestions, collapsible tool calls,
 * collapsible reasoning, error handling with retry, session management,
 * snapshot revert buttons on user messages, CUSTOM event handling.
 */

import { ScrollArea } from '@base-ui/react/scroll-area';
import { useAgent } from 'agents/react';
import {
	ArrowDown,
	Check,
	Download,
	History,
	Map as MapIcon,
	MessageCircleQuestion,
	Mic,
	MicOff,
	Pencil,
	Plus,
	ArrowUp,
	Square,
	Trash2,
	X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Collapsible } from '@/components/ui/collapsible';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/components/ui/toast-store';
import { Tooltip } from '@/components/ui/tooltip';
import { setActiveSessionId, useAiSessions } from '@/features/ai-assistant/hooks/use-ai-sessions';
import { useSnapshots } from '@/features/snapshots';
import { useMobileKeyboardLayout } from '@/hooks/use-mobile-keyboard-height';
import { createApiClient, downloadDebugLog } from '@/lib/api-client';
import { useStore } from '@/lib/store';
import { cn, formatRelativeTime } from '@/lib/utils';
import { sessionTitleSchema } from '@shared/validation';

import { ContextRing } from './context-ring';
import {
	AIError,
	AssistantMessage,
	ContinuationPrompt,
	DoomLoopAlert,
	MessageBubble,
	PendingSteeringBubble,
	UserQuestionPrompt,
	WelcomeScreen,
} from './messages';
import { getModelLimits } from './model-config';
import { ModelSelectorDropdown } from './model-selector-dialog';
import { useAutoScroll } from '../../hooks/use-auto-scroll';
import { useChangeReview } from '../../hooks/use-change-review';
import { useFileMention } from '../../hooks/use-file-mention';
import { useSpeechToText } from '../../hooks/use-speech-to-text';
import { parseTextToSegments, segmentsHaveContent, segmentsToPlainText, type InputSegment } from '../../lib/input-segments';
import { extractMessageText } from '../../lib/retry-helpers';
import { AgentModeSelector } from '../agent-mode-selector';
import { AudioWaveform, AudioWaveformSkeleton } from '../audio-waveform';
import { BouncingDots } from '../bouncing-dots';
import { ChangedFilesSummary } from '../changed-files-summary';
import { FileMentionDropdown } from '../file-mention-dropdown';
import { RevertConfirmDialog } from '../revert-confirm-dialog';
import { RichTextInput, type RichTextInputHandle } from '../rich-text-input';

import type { ChatMessage } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

type AgentConnectionState = 'connecting' | 'connected' | 'disconnected';

// =============================================================================
// Input info bar — a uniform banner displayed above the text input
// =============================================================================

/**
 * Collapsible info/warning bar rendered above the input area.
 * Used for connection status, interrupt confirmation, and similar
 * transient messages that need the user's attention.
 */
function InputInfoBar({ open, icon, children }: { open: boolean; icon: React.ReactNode; children: React.ReactNode }) {
	return (
		<Collapsible open={open}>
			<div
				className="
					flex items-center gap-2 border-b border-warning/30 bg-warning/5 px-2.5
					py-1.5
				"
			>
				{icon}
				{children}
			</div>
		</Collapsible>
	);
}

// =============================================================================
// Component
// =============================================================================

/**
 * AI agent panel with chat interface.
 */
export function AIPanel({ projectId, className }: { projectId: string; className?: string }) {
	// On mobile, when the virtual keyboard opens, switch to position:fixed so the
	// panel stays pinned above the keyboard — header and input remain visible.
	const { style: keyboardStyle, ref: keyboardReference } = useMobileKeyboardLayout();
	const [segments, setSegments] = useState<InputSegment[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [planPath, setPlanPath] = useState<string | undefined>();
	const inputReference = useRef<RichTextInputHandle>(null);

	// Track the last chatError we already surfaced so dismissing it doesn't re-trigger
	const lastSurfacedChatErrorReference = useRef<Error | undefined>(undefined);
	const revertInProgressReference = useRef(false);
	// Diff content (before/after) keyed by tool_use_id — populated from agent state pending changes
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

	// Store state (only UI preferences — AI session state comes from the Agent)
	const { files, agentMode, selectedModel, openFile, setAgentMode, setSelectedModel, clearPendingChangesByPaths } = useStore();

	// =========================================================================
	// Agents SDK: connect to the AgentRunner DO via WebSocket
	// =========================================================================

	const agent = useAgent({
		agent: 'AgentRunner',
		// basePath connects to /p/{projectId}/__agent which the worker
		// entry point forwards to the AgentRunner DO.
		// Note: partysocket prepends a "/" when building the URL, so basePath
		// must NOT start with a slash — otherwise the URL becomes "//p/...".
		basePath: `p/${projectId}/__agent`,
	});

	// =========================================================================
	// Connection state
	// =========================================================================

	// Three states:
	//   'connecting'   — socket opened but identity handshake not yet complete,
	//                    or reconnecting after a drop (PartySocket auto-retries)
	//   'connected'    — identity received from server; fully operational
	//   'disconnected' — socket closed/errored; PartySocket will retry
	//
	// agent.identified is proper React state (useState inside useAgent) so it
	// drives re-renders automatically. We layer a raw open/close listener on top
	// to distinguish 'connecting' from 'disconnected' without polling readyState.
	const [socketEverOpened, setSocketEverOpened] = useState(false);
	const agentConnectionState = useMemo((): AgentConnectionState => {
		if (agent.identified) return 'connected';
		return socketEverOpened ? 'disconnected' : 'connecting';
	}, [agent.identified, socketEverOpened]);

	useEffect(() => {
		const handleOpen = () => setSocketEverOpened(true);
		const handleClose = () => setSocketEverOpened((previous) => previous); // keep true once set
		agent.addEventListener('open', handleOpen);
		agent.addEventListener('close', handleClose);
		return () => {
			agent.removeEventListener('open', handleOpen);
			agent.removeEventListener('close', handleClose);
		};
	}, [agent]);

	// While disconnected, reset socketEverOpened when the socket reconnects so
	// we go back to 'connecting' rather than immediately showing 'disconnected'
	// during the reconnect handshake window.
	useEffect(() => {
		if (!agent.identified) {
			const handleOpen = () => setSocketEverOpened(false);
			agent.addEventListener('open', handleOpen);
			return () => agent.removeEventListener('open', handleOpen);
		}
	}, [agent, agent.identified]);

	const isConnected = agentConnectionState === 'connected';

	// Derive UI state from the Agent's auto-synced state.
	// The agent.state is typed as `unknown` from useAgent — we narrow it
	// by checking for the expected shape.
	const rawState = agent.state;
	const agentState =
		rawState && typeof rawState === 'object' && 'sessions' in rawState
			? (rawState as import('@shared/agent-state').AgentState) // eslint-disable-line @typescript-eslint/consistent-type-assertions -- narrowed above
			: undefined;
	const currentSession = agentState?.currentSession;
	const chatMessages = useMemo(() => currentSession?.messages ?? [], [currentSession?.messages]);
	const sessionId = currentSession?.sessionId;
	const statusMessage = currentSession?.statusText;
	const contextTokensUsed = currentSession?.contextTokensUsed ?? 0;
	const debugLogId = currentSession?.debugLogId;
	const isProcessing = currentSession?.status === 'running';
	const aiError = currentSession?.error;
	const pendingSteeringMessages = currentSession?.pendingSteeringMessages ?? [];
	const pendingQuestion = currentSession?.pendingQuestion;
	const needsContinuation = currentSession?.needsContinuation ?? false;
	const doomLoopMessage = currentSession?.doomLoopMessage;
	const messageSnapshots = useMemo(() => {
		const record = currentSession?.messageSnapshots ?? {};
		return new Map(Object.entries(record).map(([key, value]) => [Number(key), value]));
	}, [currentSession?.messageSnapshots]);
	const messageModes = useMemo(() => {
		const record = currentSession?.messageModes ?? {};
		return new Map(Object.entries(record).map(([key, value]) => [Number(key), value]));
	}, [currentSession?.messageModes]);

	// Derive tool metadata/errors/sub-agent activities directly from agent state via useMemo
	const toolMetadata = useMemo(() => new Map(Object.entries(currentSession?.toolMetadata ?? {})), [currentSession?.toolMetadata]);
	const toolErrors = useMemo(() => new Map(Object.entries(currentSession?.toolErrors ?? {})), [currentSession?.toolErrors]);
	const subAgentActivities = useMemo(() => currentSession?.subAgentActivities ?? {}, [currentSession?.subAgentActivities]);

	// Stable ref for sessionId access in callbacks
	const sessionIdReference = useRef(sessionId);
	useEffect(() => {
		sessionIdReference.current = sessionId;
	}, [sessionId]);

	// Smart auto-scroll: stops when user scrolls up, shows pill for new content.
	const { scrollReference, anchorReference, wrapperReference, hasNewContent, scrollToBottom, resetScrollState } = useAutoScroll();

	// Sync isProcessing to the Zustand store so external components
	// (mobile-tab-bar, ide-shell) can read it.
	useEffect(() => {
		queueMicrotask(() => useStore.getState().setProcessing(isProcessing));
	}, [isProcessing]);

	// Reset per-session UI state when the session changes
	const previousSessionIdReference = useRef(sessionId);
	useEffect(() => {
		if (sessionId !== previousSessionIdReference.current) {
			previousSessionIdReference.current = sessionId;
			queueMicrotask(() => {
				setPlanPath(undefined);
			});
		}
	}, [sessionId]);

	// Sync chatError from agent state to local error display.
	// Only surface it once — if the user dismisses it, don't re-trigger
	// until a genuinely new error arrives from the agent.
	// Track displayed error to avoid re-surfacing after dismiss
	const displayedError = aiError?.message;
	useEffect(() => {
		if (displayedError) {
			lastSurfacedChatErrorReference.current = new Error(displayedError);
		}
	}, [displayedError]);

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

	const {
		savedSessions,
		handleLoadSession: loadSession,
		handleRenameSession,
		handleDeleteSession,
		sessionSearchQuery,
		setSessionSearchQuery,
		isRestoringSession,
	} = useAiSessions({
		projectId,
		agent,
	});

	// Session rename/delete UI state
	const [renamingSessionId, setRenamingSessionId] = useState<string | undefined>();
	const [renameValue, setRenameValue] = useState('');
	const [renameError, setRenameError] = useState<string | undefined>();
	const [pendingDeleteSession, setPendingDeleteSession] = useState<{ id: string; title: string } | undefined>();

	// Snapshot hook for revert
	const { revertCascadeAsync, isReverting } = useSnapshots({ projectId });

	// Change review hook for accept/reject UI
	const changeReview = useChangeReview({ projectId });

	// Segments captured at the moment recording starts, so we can
	// prepend them to the voice transcript on stop.
	const [preRecordingSegments, setPreRecordingSegments] = useState<InputSegment[]>([]);

	// Append a transcript string to whatever the user already typed
	const appendTranscriptToInput = useCallback(
		(transcript: string) => {
			if (!transcript) {
				// No transcript — restore pre-recording segments unchanged
				setSegments(preRecordingSegments);
				return;
			}
			const knownPaths = new Set(files.map((file) => file.path));
			const transcriptSegments = parseTextToSegments(transcript, knownPaths);
			const existingText = segmentsToPlainText(preRecordingSegments);

			// Add a space separator if the existing text doesn't end with whitespace
			const needsSpace = existingText.length > 0 && !/\s$/.test(existingText);
			const merged: InputSegment[] = [
				...preRecordingSegments,
				...(needsSpace ? [{ type: 'text' as const, value: ' ' }] : []),
				...transcriptSegments,
			];
			setSegments(merged);
			requestAnimationFrame(() => {
				inputReference.current?.focus();
				inputReference.current?.moveCursorToEnd();
			});
		},
		[files, preRecordingSegments],
	);

	// Speech-to-text hook for voice input
	const speechToText = useSpeechToText({ projectId, onAutoStop: appendTranscriptToInput });

	// Move cursor to end of input as transcript grows during recording
	useEffect(() => {
		if (speechToText.isRecording && (speechToText.finalTranscript || speechToText.interimTranscript)) {
			requestAnimationFrame(() => {
				inputReference.current?.moveCursorToEnd();
			});
		}
	}, [speechToText.isRecording, speechToText.finalTranscript, speechToText.interimTranscript]);

	// Handle manually stopping STT and inserting the transcript into the input
	const handleStopRecording = useCallback(() => {
		const transcript = speechToText.stop();
		appendTranscriptToInput(transcript);
	}, [speechToText, appendTranscriptToInput]);

	// Start a new session. Pending changes are NOT cleared — they persist
	// across sessions at the project level.
	const clearHistory = useCallback(() => {
		if (!isConnected) return;
		setPlanPath(undefined);
		setFileDiffContent(new Map());
		setActiveSessionId(projectId, undefined);
		// Tell the agent to clear the current session state via RPC
		// (also aborts any running session server-side)
		void agent.call('clearCurrentSession', [isProcessing ? sessionId : undefined]);
	}, [projectId, isConnected, isProcessing, sessionId, agent]);

	// Load a session via Agent RPC and clear transient UI state
	const handleLoadSession = useCallback(
		(targetSessionId: string) => {
			if (!isConnected) return;
			if (isProcessing) {
				void agent.call('abortRun', [sessionId]);
			}
			setPlanPath(undefined);
			setFileDiffContent(new Map());
			resetScrollState();
			loadSession(targetSessionId);
			setActiveSessionId(projectId, targetSessionId);
		},
		[loadSession, projectId, isConnected, isProcessing, sessionId, agent, resetScrollState],
	);

	// Focus input on mount
	useEffect(() => {
		// Small delay to let contentEditable mount
		requestAnimationFrame(() => {
			inputReference.current?.focus();
		});
	}, []);

	// Send message via Agent RPC
	const handleSend = useCallback(
		async (messageOverride?: string) => {
			const messageText = messageOverride ?? inputPlainText.trim();
			if (!messageText || isProcessing || !isConnected) return;

			// Build the user message
			const userMessage: ChatMessage = {
				id: crypto.randomUUID(),
				role: 'user',
				parts: [{ type: 'text', content: messageText }],
				createdAt: Date.now(),
			};

			const updatedMessages = [...chatMessages, userMessage];
			const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

			if (!sessionId) {
				setActiveSessionId(projectId, resolvedSessionId);
			}

			setSegments([]);
			inputReference.current?.clear();
			scrollToBottom();

			try {
				await agent.call('startRun', [projectId, updatedMessages, agentMode, selectedModel, resolvedSessionId]);
			} catch (error: unknown) {
				if (error instanceof Error && error.name === 'AbortError') return;
				console.error('[AIPanel] Failed to start agent:', error);
			}
		},
		[inputPlainText, isConnected, isProcessing, chatMessages, sessionId, projectId, agentMode, selectedModel, agent, scrollToBottom],
	);

	// Send a steering message to the running agent without aborting it.
	// The message is queued and injected between agent loop iterations.
	const handleSteer = useCallback(
		async (messageOverride?: string) => {
			const messageText = messageOverride ?? inputPlainText.trim();
			if (!messageText || !sessionId) return;

			setSegments([]);
			inputReference.current?.clear();
			scrollToBottom();

			try {
				const result: { queued: boolean } = await agent.call('steerRun', [sessionId, messageText]);
				if (!result.queued) {
					// Session wasn't running — fall back to normal send
					void handleSend(messageText);
				}
			} catch (error: unknown) {
				console.error('[AIPanel] Failed to steer agent:', error);
			}
		},
		[inputPlainText, sessionId, agent, scrollToBottom, handleSend],
	);

	// Cancel (hard abort) the current request.
	const handleCancel = useCallback(() => {
		void agent.call('abortRun', [sessionId]).catch((error: unknown) => {
			console.error('[AIPanel] Failed to abort agent:', error);
		});
	}, [agent, sessionId]);

	// Handle keyboard shortcuts
	const handleKeyDown = useCallback(
		(event: React.KeyboardEvent) => {
			// Block keyboard shortcuts while recording — the input shows the
			// live transcript and is disabled, so there's nothing to send.
			if (speechToText.isRecording) return;

			// Let file mention dropdown handle keys first
			if (handleFileMentionKeyDown(event)) return;

			if (event.key === 'Enter' && !event.shiftKey) {
				event.preventDefault();
				if (isProcessing && hasContent && isConnected) {
					// Send as steering message — injected between agent iterations
					void handleSteer();
					return;
				}
				void handleSend();
				return;
			}

			// Escape during processing = hard abort
			if (event.key === 'Escape' && isProcessing) {
				event.preventDefault();
				handleCancel();
			}
		},
		[handleSend, handleSteer, handleFileMentionKeyDown, isConnected, isProcessing, hasContent, handleCancel, speechToText.isRecording],
	);

	// Retry: trim the failed assistant response and re-start the agent
	const handleRetry = useCallback(() => {
		const lastUser = chatMessages.toReversed().find((m) => m.role === 'user');
		if (!lastUser) return;

		const lastUserIndex = chatMessages.lastIndexOf(lastUser);
		if (lastUserIndex === -1) return;

		const trimmedHistory = chatMessages.slice(0, lastUserIndex + 1);
		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		void agent.call('startRun', [projectId, trimmedHistory, agentMode, selectedModel, resolvedSessionId]).catch((error: unknown) => {
			console.error('[AIPanel] Failed to retry:', error);
		});
	}, [chatMessages, sessionId, projectId, agentMode, selectedModel, agent]);

	// Dismiss error — track locally since error comes from agent state
	const [dismissedError, setDismissedError] = useState<string | undefined>();
	const displayError = aiError && aiError.message !== dismissedError ? aiError : undefined;
	const handleDismissError = useCallback(() => {
		if (aiError) setDismissedError(aiError.message);
	}, [aiError]);

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

	// Confirm revert (called from the dialog).
	// Cascade-reverts all snapshots from the clicked message forward within the session,
	// then surgically clears only the affected pending changes.
	const handleConfirmRevert = useCallback(
		async (snapshotIds: string[], messageIndex: number) => {
			// Mark loading state on the dialog
			setPendingRevert((previous) => (previous ? { ...previous, isLoading: true, error: undefined } : previous));

			revertInProgressReference.current = true;
			if (isProcessing) {
				void agent.call('abortRun', [sessionId]);
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
				const unrevertedFiles: string[] = [];
				for (const failed of result.failed) {
					const change = currentPendingChanges.get(failed.path);
					if (change?.beforeContent !== undefined && change.action === 'edit') {
						try {
							await apiClient.file.$put({ json: { path: failed.path, content: change.beforeContent } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback revert failed for ${failed.path}`);
							unrevertedFiles.push(failed.path.split('/').pop() ?? failed.path);
						}
					} else if (change?.action === 'create') {
						try {
							await apiClient.file.$delete({ query: { path: failed.path } });
							revertedPaths.add(failed.path);
						} catch {
							console.error(`Fallback delete failed for ${failed.path}`);
							unrevertedFiles.push(failed.path.split('/').pop() ?? failed.path);
						}
					}
				}
				if (unrevertedFiles.length > 0) {
					toast.error(
						`Could not revert ${unrevertedFiles.join(', ')}. ${unrevertedFiles.length === 1 ? 'This file' : 'These files'} may still contain AI changes — please check manually.`,
					);
				}

				// Optimistically clear only this session's pending changes for reverted files.
				// Other sessions' changes at the same paths are preserved.
				// The server's revertSession will confirm/reconcile via agent state sync.
				clearPendingChangesByPaths(revertedPaths, sessionId);

				// Revert messages on the server — awaited so errors surface in the dialog
				// and the dialog stays open until the server confirms the revert.
				await agent.call('revertSession', [sessionId, messageIndex]);

				// Restore the prompt text into the input, parsing file mentions back into pills
				if (promptText) {
					const knownPaths = new Set(files.map((file) => file.path));
					setSegments(parseTextToSegments(promptText, knownPaths));
					requestAnimationFrame(() => {
						inputReference.current?.focus();
					});
				}

				// The server's revertSession authoritatively updates pending changes
				// via agent state sync — no need to persist from the client.
				queueMicrotask(() => {
					revertInProgressReference.current = false;
				});

				// Force the preview iframe to remount so it reflects the reverted files.
				// The server-side HMR triggers (full-reload per file) may not be reliable
				// if the preview was in a broken state or multiple reloads debounced.
				globalThis.dispatchEvent(new CustomEvent('preview-force-refresh'));

				// Close the dialog on success
				setPendingRevert(undefined);

				// Warn if there were missing snapshots that couldn't be found
				if (result.missingSnapshots.length > 0) {
					console.warn('Some snapshots were not found during cascade revert:', result.missingSnapshots);
				}
			} catch (error) {
				revertInProgressReference.current = false;
				// Show error in the dialog — don't close it, let the user retry or cancel
				const message = error instanceof Error ? error.message : 'Failed to revert changes';
				setPendingRevert((previous) => (previous ? { ...previous, isLoading: false, error: message } : previous));
			}
		},
		[isProcessing, chatMessages, projectId, sessionId, files, agent, revertCascadeAsync, clearPendingChangesByPaths],
	);

	// Download debug log
	const handleDownloadDebugLog = useCallback(() => {
		if (!debugLogId) return;
		void downloadDebugLog(projectId, debugLogId, sessionId).catch(() => {
			toast.error('Could not download the debug log. Please try again.');
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
	const streamingAssistantMessage = useMemo((): ChatMessage | undefined => {
		if (!isProcessing) return undefined;
		const last = chatMessages.at(-1);
		if (last && last.role === 'assistant' && last.parts.length > 0) {
			return last;
		}
		return undefined;
	}, [isProcessing, chatMessages]);

	// Non-streaming messages (all except the streaming one)
	const displayMessages = useMemo(() => {
		if (streamingAssistantMessage) {
			return chatMessages.slice(0, -1);
		}
		return chatMessages;
	}, [chatMessages, streamingAssistantMessage]);

	return (
		<div ref={keyboardReference} className={cn('flex h-full flex-col bg-bg-secondary', className)} style={keyboardStyle}>
			{/* Header */}
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex min-w-0 items-center gap-2 overflow-hidden">
					<span className="truncate text-xs font-medium text-text-secondary">Agent</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					{/* Session dropdown */}
					<DropdownMenu>
						<Tooltip content="Sessions" side="bottom">
							<DropdownMenuTrigger>
								<Button variant="ghost" size="icon-sm">
									<History className="size-3" />
								</Button>
							</DropdownMenuTrigger>
						</Tooltip>
						<DropdownMenuContent align="end" className="max-h-80 w-64 overflow-y-auto">
							<div className="border-b border-border p-2">
								<input
									type="text"
									value={sessionSearchQuery}
									onChange={(event) => setSessionSearchQuery(event.target.value)}
									onKeyDown={(event) => event.stopPropagation()}
									placeholder="Search session history..."
									className="
										w-full rounded-sm border border-border bg-bg-primary px-2 py-1 text-xs
										text-text-primary outline-none
										focus:border-accent
									"
								/>
							</div>
							{savedSessions.length === 0 ? (
								<div className="px-3 py-2 text-xs text-text-secondary">
									{sessionSearchQuery.trim() ? 'No matching sessions' : 'No recent sessions'}
								</div>
							) : (
								savedSessions.map((session) =>
									renamingSessionId === session.id ? (
										<div key={session.id} className="flex items-center gap-1 px-2 py-1.5">
											<input
												autoFocus
												type="text"
												value={renameValue}
												onChange={(event) => {
													setRenameValue(event.target.value);
													setRenameError(undefined);
												}}
												onKeyDown={(event) => {
													if (event.key === 'Enter') {
														event.preventDefault();
														const parsed = sessionTitleSchema.safeParse(renameValue);
														if (!parsed.success) {
															setRenameError(parsed.error.issues[0]?.message ?? 'Invalid title');
															return;
														}
														void handleRenameSession(session.id, parsed.data).then((success) => {
															if (success) setRenamingSessionId(undefined);
														});
													}
													if (event.key === 'Escape') {
														event.preventDefault();
														setRenamingSessionId(undefined);
														setRenameError(undefined);
													}
													event.stopPropagation();
												}}
												className={cn(
													`
														min-w-0 flex-1 rounded-sm border bg-bg-primary px-1.5 py-0.5
														text-sm text-text-primary outline-none
													`,
													renameError
														? 'border-error'
														: `
															border-border
															focus:border-accent
														`,
												)}
												title={renameError}
											/>
											<button
												type="button"
												onClick={() => {
													const parsed = sessionTitleSchema.safeParse(renameValue);
													if (!parsed.success) {
														setRenameError(parsed.error.issues[0]?.message ?? 'Invalid title');
														return;
													}
													void handleRenameSession(session.id, parsed.data).then((success) => {
														if (success) setRenamingSessionId(undefined);
													});
												}}
												className="
													rounded-sm p-0.5 text-text-secondary transition-colors
													hover:bg-bg-tertiary hover:text-success
												"
											>
												<Check className="size-3.5" />
											</button>
											<button
												type="button"
												onClick={() => {
													setRenamingSessionId(undefined);
													setRenameError(undefined);
												}}
												className="
													rounded-sm p-0.5 text-text-secondary transition-colors
													hover:bg-bg-tertiary hover:text-error
												"
											>
												<X className="size-3.5" />
											</button>
										</div>
									) : (
										<DropdownMenuItem key={session.id} onSelect={() => handleLoadSession(session.id)}>
											<div
												className="
													group/session flex w-full items-center justify-between gap-1
												"
												title={session.title}
											>
												<span className="truncate text-sm">{session.title}</span>
												<div className="flex shrink-0 items-center gap-0.5">
													{session.isRunning && <Spinner className="size-3 text-warning" />}
													<span
														className="
															text-2xs text-text-secondary
															group-hover/session:hidden
														"
													>
														{formatRelativeTime(session.createdAt)}
													</span>
													<button
														type="button"
														onClick={(event) => {
															event.stopPropagation();
															setRenamingSessionId(session.id);
															setRenameValue(session.title);
															setRenameError(undefined);
														}}
														className="
															hidden rounded-sm p-0.5 text-text-secondary transition-colors
															group-hover/session:block
															hover:bg-bg-tertiary hover:text-text-primary
														"
													>
														<Pencil className="size-3" />
													</button>
													<button
														type="button"
														onClick={(event) => {
															event.stopPropagation();
															setPendingDeleteSession({ id: session.id, title: session.title });
														}}
														className="
															hidden rounded-sm p-0.5 text-text-secondary transition-colors
															group-hover/session:block
															hover:bg-bg-tertiary hover:text-error
														"
													>
														<Trash2 className="size-3" />
													</button>
												</div>
											</div>
										</DropdownMenuItem>
									),
								)
							)}
						</DropdownMenuContent>
					</DropdownMenu>

					{/* New session — always available when there's history, even while streaming */}
					{chatMessages.length > 0 && (
						<Tooltip content="New session" side="bottom">
							<Button variant="ghost" size="icon-sm" onClick={clearHistory} disabled={!isConnected}>
								<Plus className="size-3.5" />
							</Button>
						</Tooltip>
					)}
				</div>
			</div>

			{/* Current session title bar with status indicator */}
			{chatMessages.length > 0 &&
				(() => {
					const currentSession = savedSessions.find((session) => session.id === sessionId);
					const sessionTitle = currentSession?.title ?? 'New session';
					const needsAttention = !!pendingQuestion || needsContinuation || !!doomLoopMessage;
					return (
						<div
							className="
								flex h-7 shrink-0 items-center gap-1.5 border-b border-border px-3
							"
							title={sessionTitle}
						>
							{/* Connection state dot */}
							<Tooltip
								content={
									agentConnectionState === 'connected'
										? 'Connected'
										: agentConnectionState === 'connecting'
											? 'Connecting…'
											: 'Reconnecting…'
								}
								side="bottom"
							>
								<span
									className={cn(
										'size-1.5 shrink-0 rounded-full transition-colors',
										agentConnectionState === 'connected'
											? 'bg-success'
											: agentConnectionState === 'connecting'
												? 'animate-pulse bg-text-secondary/50'
												: 'animate-pulse bg-error',
									)}
								/>
							</Tooltip>
							{needsAttention && (
								<Tooltip content="Action required">
									<MessageCircleQuestion className="size-3 shrink-0 text-accent" />
								</Tooltip>
							)}
							<span className="truncate text-2xs text-text-secondary">{sessionTitle}</span>
						</div>
					);
				})()}

			{/* Messages — with fade edges and smart auto-scroll */}
			<div ref={wrapperReference} className="group/scroll relative flex-1 overflow-hidden">
				{/* Top fade edge — driven by data-can-scroll-up on the wrapper (no React state) */}
				<div
					className="
						pointer-events-none absolute inset-x-0 top-0 z-10 h-6 bg-linear-to-b
						from-bg-secondary to-transparent opacity-0 transition-opacity duration-200
						group-data-can-scroll-up/scroll:opacity-100
					"
				/>

				<ScrollArea.Root className="size-full">
					<ScrollArea.Viewport ref={scrollReference} className="size-full">
						<div className="flex min-w-0 flex-col gap-3 p-2">
							{displayMessages.length === 0 && !streamingAssistantMessage ? (
								isRestoringSession ? (
									<div
										className="
											flex flex-1 flex-col items-center justify-center gap-2 py-12
											text-text-secondary
										"
									>
										<Spinner className="size-5" />
										<span className="text-sm">Restoring session...</span>
									</div>
								) : (
									<WelcomeScreen onSuggestionClick={handleSuggestion} onModeChange={setAgentMode} />
								)
							) : (
								<>
									{displayMessages.map((message, index) => (
										<MessageBubble
											key={message.id}
											message={message}
											messageIndex={index}
											snapshotId={messageSnapshots.get(index)}
											agentMode={messageModes.get(index)}
											isReverting={isReverting}
											revertingMessageIndex={pendingRevert?.isLoading ? pendingRevert.messageIndex : undefined}
											onRevert={handleRevert}
											toolErrors={toolErrors}
											toolMetadata={toolMetadata}
											fileDiffContent={fileDiffContent}
											subAgentActivities={subAgentActivities}
											projectId={projectId}
											showHeader={message.role !== 'assistant' || index === 0 || displayMessages[index - 1]?.role !== 'assistant'}
										/>
									))}
								</>
							)}
							{/* Pending steering messages (queued but not yet consumed by agent) */}
							{pendingSteeringMessages.map((pending) => (
								<PendingSteeringBubble key={pending.id} content={pending.content} />
							))}
							{/* Streaming assistant message */}
							{streamingAssistantMessage && (
								<AssistantMessage
									message={streamingAssistantMessage}
									streaming
									toolErrors={toolErrors}
									toolMetadata={toolMetadata}
									fileDiffContent={fileDiffContent}
									subAgentActivities={subAgentActivities}
									projectId={projectId}
									showHeader={displayMessages.length === 0 || displayMessages.at(-1)?.role !== 'assistant'}
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
								<ContinuationPrompt onContinue={() => void handleSend('continue')} onDismiss={() => {}} />
							)}
							{/* Doom loop alert — shown when the agent was stopped due to repetitive behavior */}
							{doomLoopMessage && !isProcessing && <DoomLoopAlert message={doomLoopMessage} onRetry={handleRetry} onDismiss={() => {}} />}
							{/* AI Error display */}
							{displayError && (
								<AIError message={displayError.message} code={displayError.code} onRetry={handleRetry} onDismiss={handleDismissError} />
							)}
							{statusMessage ? (
								<div
									className="
										flex animate-chat-item items-center gap-2 px-1 text-xs
										text-text-secondary
									"
								>
									<Spinner className="size-3" />
									{statusMessage}
								</div>
							) : undefined}

							{/* Actions for the last agent message (e.g. log download, future feedback) */}
							{!isProcessing && chatMessages.length > 0 && chatMessages.at(-1)?.role === 'assistant' && (
								<div className="flex animate-chat-item items-center justify-end gap-2 px-2">
									{debugLogId && (
										<Tooltip content="Download debug log" side="bottom">
											<button
												onClick={handleDownloadDebugLog}
												className={cn(
													`
														inline-flex cursor-pointer items-center gap-1.5 rounded-md px-1.5
														py-1
													`,
													'text-xs font-medium text-text-secondary transition-colors',
													'hover:bg-bg-tertiary hover:text-text-primary',
												)}
											>
												<Download className="size-3" />
												Agent Log
											</button>
										</Tooltip>
									)}
								</div>
							)}

							{/* Invisible anchor for auto-scroll detection */}
							<div ref={anchorReference} className="h-px shrink-0" aria-hidden />
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>

				{/* Bottom fade edge — driven by data-can-scroll-down on the wrapper (no React state) */}
				<div
					className="
						pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t
						from-bg-secondary to-transparent opacity-0 transition-opacity duration-200
						group-data-can-scroll-down/scroll:opacity-100
					"
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
			<div className="relative shrink-0 border-t border-border p-2">
				{/* File mention autocomplete dropdown — must be outside overflow-hidden */}
				{isFileMentionOpen && (
					<FileMentionDropdown results={fileMentionResults} selectedIndex={fileMentionSelectedIndex} onSelect={selectMentionFile} />
				)}
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
					{/* Connection status bar */}
					<InputInfoBar open={!isConnected} icon={<Spinner className="size-3 shrink-0 text-warning" />}>
						<span className="flex-1 text-xs text-text-secondary">
							{agentConnectionState === 'connecting' ? 'Connecting to agent…' : 'Connection lost. Reconnecting…'}
						</span>
					</InputInfoBar>

					<RichTextInput
						ref={inputReference}
						segments={
							speechToText.isRecording
								? (() => {
										const voiceText = [speechToText.finalTranscript, speechToText.interimTranscript].filter(Boolean).join(' ');
										const existingText = segmentsToPlainText(preRecordingSegments);
										const needsSpace = existingText.length > 0 && voiceText.length > 0 && !/\s$/.test(existingText);
										return [
											...preRecordingSegments,
											...(needsSpace ? [{ type: 'text' as const, value: ' ' }] : []),
											...(voiceText ? [{ type: 'text' as const, value: voiceText }] : []),
										];
									})()
								: segments
						}
						onSegmentsChange={setSegments}
						onKeyDown={handleKeyDown}
						onCursorChange={setCursorPosition}
						disabled={speechToText.isRecording}
						inlineSuffix={speechToText.isRecording ? <BouncingDots className="ml-1 text-text-secondary" /> : undefined}
						placeholder={
							isProcessing
								? 'Type your next message...'
								: agentMode === 'plan'
									? 'Describe what to plan...'
									: agentMode === 'ask'
										? 'Ask a question...'
										: 'Ask the AI to help...'
						}
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
					{speechToText.isRecording ? (
						<div className="flex items-center gap-x-1.5 px-1.5 py-1">
							{/* Pulsing recording dot */}
							<div className="relative flex size-3 shrink-0 items-center justify-center">
								<Spinner
									size="xs"
									className={cn(
										`
											absolute inset-0 text-text-secondary transition-opacity duration-150
											ease-out
										`,
										speechToText.isMicrophoneReady && 'pointer-events-none opacity-0',
									)}
								/>
								<span
									className={cn(
										`
											size-2 rounded-full bg-error transition-opacity duration-150 ease-out
										`,
										speechToText.isMicrophoneReady ? 'animate-pulse opacity-100' : 'opacity-0',
									)}
								/>
							</div>
							{/* Rolling waveform visualization */}
							<div className="relative h-4 w-28 shrink-0">
								<AudioWaveformSkeleton
									className={cn(
										'absolute inset-0 transition-opacity duration-150 ease-out',
										speechToText.isMicrophoneReady && 'pointer-events-none opacity-0',
									)}
								/>
								<AudioWaveform
									amplitudes={speechToText.amplitudes}
									className={cn(
										'absolute inset-0 transition-opacity duration-150 ease-out',
										speechToText.isMicrophoneReady ? 'opacity-100' : 'opacity-0',
									)}
								/>
							</div>
							<div className="flex-1" />
							<button
								onClick={handleStopRecording}
								className={cn(
									'inline-flex cursor-pointer items-center gap-1.5 rounded-md p-1',
									'text-xs font-medium text-error transition-colors',
									'hover:bg-error/10',
								)}
								aria-label="Stop recording"
							>
								<Square className="size-4" />
							</button>
						</div>
					) : (
						<div
							className="
								@container flex flex-wrap-reverse items-center gap-x-1.5 gap-y-0.5
								px-1.5 py-1
							"
						>
							<AgentModeSelector mode={agentMode} onModeChange={setAgentMode} disabled={isProcessing || !isConnected} />
							<ModelSelectorDropdown
								selectedModel={selectedModel}
								onSelectModel={setSelectedModel}
								disabled={isProcessing || !isConnected}
							/>
							<div className="flex flex-1 shrink-0 items-center justify-end gap-0.5">
								<ContextRing tokensUsed={contextTokensUsed} contextWindow={getModelLimits(selectedModel).contextWindow} />
								{/* Microphone button */}
								{!isProcessing && speechToText.microphonePermission !== 'unsupported' && (
									<Tooltip content={speechToText.microphonePermission === 'denied' ? 'Microphone blocked' : 'Voice input'} side="top">
										<button
											onClick={() => {
												if (speechToText.microphonePermission === 'denied') {
													toast.info('Allow microphone access for this site in your browser settings, then try again.');
													return;
												}
												setPreRecordingSegments(segments);
												void speechToText.start();
											}}
											disabled={!isConnected}
											className={cn(
												'inline-flex items-center gap-1.5 rounded-md p-1',
												'text-xs font-medium transition-colors',
												speechToText.microphonePermission === 'denied'
													? 'cursor-pointer text-text-secondary opacity-50'
													: isConnected
														? `
															cursor-pointer text-text-secondary
															hover:bg-bg-tertiary hover:text-text-primary
														`
														: 'cursor-not-allowed text-text-secondary opacity-40',
											)}
											aria-label={speechToText.microphonePermission === 'denied' ? 'Microphone blocked' : 'Start voice input'}
										>
											{speechToText.microphonePermission === 'denied' ? <MicOff className="size-4" /> : <Mic className="size-4" />}
										</button>
									</Tooltip>
								)}
								{isProcessing ? (
									<button
										onClick={handleCancel}
										className={cn(
											`
												inline-flex cursor-pointer items-center justify-center rounded-md
												p-1
											`,
											'text-xs font-medium text-error transition-colors',
											'hover:bg-error/10',
										)}
										aria-label="Stop"
									>
										<Square className="size-4" />
									</button>
								) : (
									<button
										onClick={() => void handleSend()}
										disabled={!hasContent || !isConnected}
										className={cn(
											'inline-flex items-center justify-center rounded-md p-1',
											'text-xs font-medium transition-colors',
											hasContent && isConnected
												? `
													cursor-pointer bg-accent text-white
													hover:bg-accent-hover
												`
												: 'cursor-not-allowed text-text-secondary opacity-40',
										)}
										aria-label="Send"
									>
										<ArrowUp className="size-4" />
									</button>
								)}
							</div>
						</div>
					)}
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

			{/* Delete session confirmation dialog */}
			<ConfirmDialog
				open={!!pendingDeleteSession}
				onOpenChange={(open) => {
					if (!open) setPendingDeleteSession(undefined);
				}}
				title="Delete session"
				description={
					<div className="space-y-4">
						<p className="text-sm font-medium">Are you sure you want to delete this session?</p>
						<p
							className="
								truncate rounded-sm border border-border bg-bg-tertiary px-2 py-1
								text-sm font-medium text-text-primary
							"
						>
							{pendingDeleteSession?.title}
						</p>
						<p className="text-xs text-text-secondary">This action cannot be undone. Your code changes will be preserved.</p>
					</div>
				}
				confirmLabel="Delete"
				variant="danger"
				onConfirm={() => {
					if (pendingDeleteSession) {
						void handleDeleteSession(pendingDeleteSession.id);
						setPendingDeleteSession(undefined);
					}
				}}
			/>
		</div>
	);
}
