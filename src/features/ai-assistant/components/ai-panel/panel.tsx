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
import { isAgentState } from '@/features/ai-assistant/lib/agent-state';
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
	QueuedSteeringStrip,
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

import type { AIModelId } from '@shared/constants';
import type { AgentMode, ChatMessage } from '@shared/types';

type AgentConnectionState = 'connecting' | 'connected' | 'disconnected';

type OptimisticMessageEntry = {
	sessionId: string;
	message: ChatMessage;
	clientOnly: boolean;
	submitting: boolean;
};

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

function isQueuedRequestMessage(message: ChatMessage): boolean {
	return message.role === 'user' && message.metadata?.request?.state === 'queued';
}

function createOptimisticUserMessage(
	messageText: string,
	mode: AgentMode,
	model: AIModelId,
	state: 'queued' | 'committed',
	id: string,
	createdAt: number,
): ChatMessage {
	return {
		id,
		role: 'user',
		parts: [{ type: 'text', content: messageText }],
		createdAt,
		metadata: {
			request: {
				mode,
				model,
				state,
			},
		},
	};
}

export function AIPanel({ projectId, className }: { projectId: string; className?: string }) {
	// On mobile, when the virtual keyboard opens, switch to position:fixed so the
	// panel stays pinned above the keyboard — header and input remain visible.
	const { style: keyboardStyle, ref: keyboardReference } = useMobileKeyboardLayout();
	const [segments, setSegments] = useState<InputSegment[]>([]);
	const [cursorPosition, setCursorPosition] = useState(0);
	const [planPath, setPlanPath] = useState<string | undefined>();
	const inputReference = useRef<RichTextInputHandle>(null);

	const lastSurfacedChatErrorReference = useRef<Error | undefined>(undefined);
	const revertInProgressReference = useRef(false);
	const [fileDiffContent, setFileDiffContent] = useState<Map<string, { beforeContent: string; afterContent: string }>>(new Map());
	const [optimisticStoppingSessionId, setOptimisticStoppingSessionId] = useState<string | undefined>();
	const [optimisticMessages, setOptimisticMessages] = useState<OptimisticMessageEntry[]>([]);
	const [optimisticRemovedQueuedMessages, setOptimisticRemovedQueuedMessages] = useState<Array<{ sessionId: string; messageId: string }>>(
		[],
	);

	const inputPlainText = useMemo(() => segmentsToPlainText(segments), [segments]);
	const hasContent = useMemo(() => segmentsHaveContent(segments), [segments]);

	const [pendingRevert, setPendingRevert] = useState<
		{ snapshotIds: string[]; messageIndex: number; isLoading: boolean; error?: string } | undefined
	>();

	const { files, agentMode, selectedModel, openFile, setAgentMode, setSelectedModel, clearPendingChangesByPaths } = useStore();

	const agent = useAgent({
		agent: 'AgentRunner',
		// basePath connects to /p/{projectId}/__agent which the worker
		// entry point forwards to the AgentRunner DO.
		// Note: partysocket prepends a "/" when building the URL, so basePath
		// must NOT start with a slash — otherwise the URL becomes "//p/...".
		basePath: `p/${projectId}/__agent`,
	});

	// useAgent exposes identification state, so track whether the socket has ever
	// opened to distinguish the initial handshake from a reconnecting socket.
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

	useEffect(() => {
		if (!agent.identified) {
			const handleOpen = () => setSocketEverOpened(false);
			agent.addEventListener('open', handleOpen);
			return () => agent.removeEventListener('open', handleOpen);
		}
	}, [agent, agent.identified]);

	const isConnected = agentConnectionState === 'connected';

	const rawState = agent.state;
	const agentState = isAgentState(rawState) ? rawState : undefined;
	const currentSession = agentState?.currentSession;
	const sessionId = currentSession?.sessionId;
	const statusMessage = currentSession?.statusText;
	const contextTokensUsed = currentSession?.contextTokensUsed ?? 0;
	const debugLogId = currentSession?.debugLogId;
	const isProcessing = currentSession?.status === 'running';
	const aiError = currentSession?.error;
	const stopRequested = currentSession?.stopRequested ?? false;
	const isStopPending = isProcessing && ((sessionId !== undefined && optimisticStoppingSessionId === sessionId) || stopRequested);
	const pendingQuestion = currentSession?.pendingQuestion;
	const needsContinuation = currentSession?.needsContinuation ?? false;
	const doomLoopMessage = currentSession?.doomLoopMessage;
	const renderedSessionId = sessionId ?? optimisticMessages.at(-1)?.sessionId;
	const renderedOptimisticEntries = useMemo(
		() => (renderedSessionId ? optimisticMessages.filter((entry) => entry.sessionId === renderedSessionId) : []),
		[optimisticMessages, renderedSessionId],
	);
	const renderedOptimisticMessages = useMemo(() => renderedOptimisticEntries.map((entry) => entry.message), [renderedOptimisticEntries]);
	const localOnlyMessageIds = useMemo(
		() => new Set(renderedOptimisticEntries.filter((entry) => entry.clientOnly).map((entry) => entry.message.id)),
		[renderedOptimisticEntries],
	);
	const removedQueuedMessageIds = useMemo(
		() => new Set(optimisticRemovedQueuedMessages.filter((entry) => entry.sessionId === renderedSessionId).map((entry) => entry.messageId)),
		[optimisticRemovedQueuedMessages, renderedSessionId],
	);
	const allMessages = useMemo(() => {
		const baseMessages = currentSession?.messages ?? [];
		const mergedMessages =
			renderedOptimisticMessages.length === 0
				? baseMessages
				: [
						...baseMessages,
						...renderedOptimisticMessages.filter((message) => !new Set(baseMessages.map((entry) => entry.id)).has(message.id)),
					];

		if (removedQueuedMessageIds.size === 0) {
			return mergedMessages;
		}

		return mergedMessages.filter((message) => !removedQueuedMessageIds.has(message.id));
	}, [currentSession?.messages, renderedOptimisticMessages, removedQueuedMessageIds]);
	const queuedMessages = useMemo(() => allMessages.filter((message) => isQueuedRequestMessage(message)), [allMessages]);
	const committedMessages = useMemo(() => allMessages.filter((message) => !isQueuedRequestMessage(message)), [allMessages]);

	// Derive tool metadata/errors/sub-agent activities directly from agent state via useMemo
	const toolMetadata = useMemo(() => new Map(Object.entries(currentSession?.toolMetadata ?? {})), [currentSession?.toolMetadata]);
	const toolErrors = useMemo(() => new Map(Object.entries(currentSession?.toolErrors ?? {})), [currentSession?.toolErrors]);
	const subAgentActivities = useMemo(() => currentSession?.subAgentActivities ?? {}, [currentSession?.subAgentActivities]);

	// Stable ref for sessionId access in callbacks
	const sessionIdReference = useRef(sessionId);
	useEffect(() => {
		sessionIdReference.current = sessionId;
	}, [sessionId]);
	const optimisticMessagesReference = useRef(optimisticMessages);
	useEffect(() => {
		optimisticMessagesReference.current = optimisticMessages;
	}, [optimisticMessages]);
	const flushingClientQueueReference = useRef(false);

	// Smart auto-scroll: stops when user scrolls up, shows pill for new content.
	const { scrollReference, anchorReference, wrapperReference, hasNewContent, scrollToBottom, resetScrollState } = useAutoScroll();

	// Sync isProcessing to the Zustand store so external components
	// (mobile-tab-bar, ide-shell) can read it.
	useEffect(() => {
		queueMicrotask(() => useStore.getState().setProcessing(isProcessing));
	}, [isProcessing]);

	useEffect(() => {
		if (!optimisticStoppingSessionId) return;
		if (sessionId !== optimisticStoppingSessionId || stopRequested || !isProcessing) {
			queueMicrotask(() => setOptimisticStoppingSessionId(undefined));
		}
	}, [optimisticStoppingSessionId, sessionId, stopRequested, isProcessing]);

	useEffect(() => {
		if (!renderedSessionId) return;
		const persistedIds = new Set((currentSession?.messages ?? []).map((message) => message.id));
		queueMicrotask(() =>
			setOptimisticMessages((previous) =>
				previous.filter((entry) => {
					if (entry.sessionId !== renderedSessionId) {
						return true;
					}
					return !persistedIds.has(entry.message.id);
				}),
			),
		);
	}, [currentSession?.messages, renderedSessionId]);

	useEffect(() => {
		if (!renderedSessionId) return;
		const liveIds = new Set([
			...(currentSession?.messages ?? []).map((message) => message.id),
			...renderedOptimisticMessages.map((message) => message.id),
		]);
		queueMicrotask(() =>
			setOptimisticRemovedQueuedMessages((previous) =>
				previous.filter((entry) => entry.sessionId !== renderedSessionId || liveIds.has(entry.messageId)),
			),
		);
	}, [currentSession?.messages, renderedOptimisticMessages, renderedSessionId]);

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
		setOptimisticMessages([]);
		setOptimisticRemovedQueuedMessages([]);
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
			setOptimisticMessages([]);
			setOptimisticRemovedQueuedMessages([]);
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

	const submitOptimisticMessage = useCallback(
		async (entry: OptimisticMessageEntry): Promise<boolean> => {
			const request = entry.message.metadata?.request;
			const messageText = extractMessageText(entry.message);
			if (!request?.mode || !request.model || !messageText) {
				setOptimisticMessages((previous) => previous.filter((candidate) => candidate.message.id !== entry.message.id));
				return false;
			}

			setOptimisticMessages((previous) =>
				previous.map((candidate) => (candidate.message.id === entry.message.id ? { ...candidate, submitting: true } : candidate)),
			);

			try {
				const result = await agent.call<{ sessionId: string; queued: boolean; started: boolean }>('submitMessage', [
					projectId,
					messageText,
					entry.sessionId,
					request.mode,
					request.model,
					entry.message.id,
					entry.message.createdAt ?? Date.now(),
				]);

				setActiveSessionId(projectId, result.sessionId);
				setOptimisticMessages((previous) =>
					previous.map((candidate) =>
						candidate.message.id === entry.message.id
							? {
									...candidate,
									sessionId: result.sessionId,
									clientOnly: false,
									submitting: false,
									message: {
										...candidate.message,
										metadata: {
											...candidate.message.metadata,
											request: {
												...candidate.message.metadata?.request,
												state: result.queued ? 'queued' : 'committed',
											},
										},
									},
								}
							: candidate,
					),
				);

				return true;
			} catch (error: unknown) {
				if (!agent.identified) {
					setOptimisticMessages((previous) =>
						previous.map((candidate) =>
							candidate.message.id === entry.message.id ? { ...candidate, clientOnly: true, submitting: false } : candidate,
						),
					);
					return false;
				}

				setOptimisticMessages((previous) => previous.filter((candidate) => candidate.message.id !== entry.message.id));
				if (error instanceof Error && error.name === 'AbortError') {
					return false;
				}
				console.error('[AIPanel] Failed to submit message:', error);
				toast.error('Could not send the message. Please try again.');
				return false;
			}
		},
		[agent, projectId],
	);

	useEffect(() => {
		if (!isConnected || flushingClientQueueReference.current) return;
		if (!optimisticMessages.some((entry) => entry.clientOnly && !entry.submitting)) return;

		flushingClientQueueReference.current = true;
		void (async () => {
			try {
				while (agent.identified) {
					const nextEntry = optimisticMessagesReference.current.find((entry) => entry.clientOnly && !entry.submitting);
					if (!nextEntry) break;
					const submitted = await submitOptimisticMessage(nextEntry);
					if (!submitted && !agent.identified) break;
				}
			} finally {
				flushingClientQueueReference.current = false;
			}
		})();
	}, [agent.identified, isConnected, optimisticMessages, submitOptimisticMessage]);

	// Submit a new request. The server decides whether it starts immediately or queues.
	const handleSubmit = useCallback(
		async (messageOverride?: string) => {
			const messageText = messageOverride ?? inputPlainText.trim();
			if (!messageText) return;

			const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);
			const optimisticMessageId = crypto.randomUUID();
			const optimisticCreatedAt = Date.now();
			const optimisticMessage = createOptimisticUserMessage(
				messageText,
				agentMode,
				selectedModel,
				isProcessing || isStopPending || stopRequested ? 'queued' : 'committed',
				optimisticMessageId,
				optimisticCreatedAt,
			);

			if (!sessionId) {
				setActiveSessionId(projectId, resolvedSessionId);
			}

			const optimisticEntry: OptimisticMessageEntry = {
				sessionId: resolvedSessionId,
				message: optimisticMessage,
				clientOnly: !isConnected,
				submitting: false,
			};

			setOptimisticMessages((previous) => [...previous, optimisticEntry]);
			setSegments([]);
			setOptimisticStoppingSessionId(undefined);
			inputReference.current?.clear();
			scrollToBottom();

			if (isConnected) {
				await submitOptimisticMessage(optimisticEntry);
			}
		},
		[
			inputPlainText,
			isConnected,
			isProcessing,
			isStopPending,
			stopRequested,
			sessionId,
			projectId,
			agentMode,
			selectedModel,
			scrollToBottom,
			submitOptimisticMessage,
		],
	);

	const handleRemoveQueuedMessage = useCallback(
		(messageId: string) => {
			if (!renderedSessionId) return;

			const optimisticQueuedEntry = renderedOptimisticEntries.find((entry) => entry.message.id === messageId);
			if (optimisticQueuedEntry?.clientOnly && !optimisticQueuedEntry.submitting) {
				setOptimisticMessages((previous) =>
					previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.message.id === messageId)),
				);
				return;
			}

			const optimisticQueuedMessage = optimisticQueuedEntry?.message;
			setOptimisticMessages((previous) =>
				previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.message.id === messageId)),
			);
			setOptimisticRemovedQueuedMessages((previous) => {
				if (previous.some((entry) => entry.sessionId === renderedSessionId && entry.messageId === messageId)) {
					return previous;
				}
				return [...previous, { sessionId: renderedSessionId, messageId }];
			});

			void agent
				.call<{ removed: boolean }>('removeQueuedMessage', [renderedSessionId, messageId])
				.then((result) => {
					if (result.removed) return;
					setOptimisticRemovedQueuedMessages((previous) =>
						previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.messageId === messageId)),
					);
					if (optimisticQueuedMessage) {
						setOptimisticMessages((previous) => [
							...previous,
							{ sessionId: renderedSessionId, message: optimisticQueuedMessage, clientOnly: false, submitting: false },
						]);
					}
				})
				.catch((error: unknown) => {
					setOptimisticRemovedQueuedMessages((previous) =>
						previous.filter((entry) => !(entry.sessionId === renderedSessionId && entry.messageId === messageId)),
					);
					if (optimisticQueuedMessage) {
						setOptimisticMessages((previous) => [
							...previous,
							{ sessionId: renderedSessionId, message: optimisticQueuedMessage, clientOnly: false, submitting: false },
						]);
					}
					console.error('[AIPanel] Failed to remove queued message:', error);
					toast.error('Could not remove the queued message. Please try again.');
				});
		},
		[agent, renderedOptimisticEntries, renderedSessionId],
	);

	// Cancel (hard abort) the current request.
	const handleCancel = useCallback(() => {
		if (!sessionId || !isProcessing || stopRequested || optimisticStoppingSessionId === sessionId) return;
		setOptimisticStoppingSessionId(sessionId);
		void agent.call('abortRun', [sessionId]).catch((error: unknown) => {
			setOptimisticStoppingSessionId((currentSessionId) => (currentSessionId === sessionId ? undefined : currentSessionId));
			console.error('[AIPanel] Failed to abort agent:', error);
			toast.error('Could not stop the agent. Please try again.');
		});
	}, [agent, sessionId, isProcessing, optimisticStoppingSessionId, stopRequested]);

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
				void handleSubmit();
				return;
			}

			// Escape during processing = hard abort
			if (event.key === 'Escape' && isProcessing) {
				event.preventDefault();
				handleCancel();
			}
		},
		[handleSubmit, handleFileMentionKeyDown, isProcessing, handleCancel, speechToText.isRecording],
	);

	// Retry: trim the failed assistant response and re-start the agent
	const handleRetry = useCallback(() => {
		const lastUser = committedMessages.toReversed().find((message) => message.role === 'user');
		if (!lastUser) return;

		const lastUserIndex = committedMessages.lastIndexOf(lastUser);
		if (lastUserIndex === -1) return;

		const trimmedHistory = committedMessages.slice(0, lastUserIndex + 1);
		const resolvedSessionId = sessionId ?? crypto.randomUUID().replaceAll('-', '').slice(0, 16);

		setOptimisticStoppingSessionId(undefined);
		void agent.call('startRun', [projectId, trimmedHistory, agentMode, selectedModel, resolvedSessionId]).catch((error: unknown) => {
			console.error('[AIPanel] Failed to retry:', error);
		});
	}, [committedMessages, sessionId, projectId, agentMode, selectedModel, agent]);

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
			const sortedSnapshotIds = committedMessages
				.slice(messageIndex)
				.map((message) => message.metadata?.snapshotId)
				.filter((snapshotId): snapshotId is string => !!snapshotId)
				.toReversed();

			if (sortedSnapshotIds.length === 0) return;

			setPendingRevert({ snapshotIds: sortedSnapshotIds, messageIndex, isLoading: false });
		},
		[committedMessages],
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
			const userMessage = committedMessages[messageIndex];
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
		[isProcessing, committedMessages, projectId, sessionId, files, agent, revertCascadeAsync, clearPendingChangesByPaths],
	);

	// Download debug log
	const handleDownloadDebugLog = useCallback(() => {
		if (!debugLogId) return;
		void downloadDebugLog(projectId, debugLogId, sessionId).catch(() => {
			toast.error('Could not download the debug log. Please try again.');
		});
	}, [debugLogId, projectId, sessionId]);

	const handleSuggestion = useCallback(
		(prompt: string) => {
			void handleSubmit(prompt);
		},
		[handleSubmit],
	);

	const streamingAssistantMessage = useMemo((): ChatMessage | undefined => {
		if (!isProcessing) return undefined;
		const last = committedMessages.at(-1);
		if (last && last.role === 'assistant' && last.parts.length > 0) {
			return last;
		}
		return undefined;
	}, [isProcessing, committedMessages]);

	const displayMessages = useMemo(() => {
		if (streamingAssistantMessage) {
			return committedMessages.slice(0, -1);
		}
		return committedMessages;
	}, [committedMessages, streamingAssistantMessage]);

	return (
		<div ref={keyboardReference} className={cn('flex h-full flex-col bg-bg-secondary', className)} style={keyboardStyle}>
			<div
				className="
					flex h-9 shrink-0 items-center justify-between border-b border-border px-3
				"
			>
				<div className="flex min-w-0 items-center gap-2 overflow-hidden">
					<span className="truncate text-xs font-medium text-text-secondary">Agent</span>
				</div>
				<div className="flex shrink-0 items-center gap-1">
					<DropdownMenu>
						<Tooltip content="Sessions" side="bottom">
							<DropdownMenuTrigger>
								<Button variant="ghost" size="icon" aria-label="Sessions">
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

					{allMessages.length > 0 && (
						<Tooltip content="New session" side="bottom">
							<Button variant="ghost" size="icon" aria-label="New session" onClick={clearHistory} disabled={!isConnected}>
								<Plus className="size-3.5" />
							</Button>
						</Tooltip>
					)}
				</div>
			</div>

			{allMessages.length > 0 &&
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

			<div ref={wrapperReference} className="group/scroll relative flex-1 overflow-hidden">
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
											snapshotId={message.metadata?.snapshotId}
											agentMode={message.metadata?.request?.mode}
											modelId={message.metadata?.request?.model}
											isClientOnly={localOnlyMessageIds.has(message.id)}
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
							{pendingQuestion && !isProcessing && (
								<UserQuestionPrompt
									question={pendingQuestion.question}
									options={pendingQuestion.options}
									onOptionClick={(option) => void handleSubmit(option)}
								/>
							)}
							{needsContinuation && !isProcessing && (
								<ContinuationPrompt onContinue={() => void handleSubmit('continue')} onDismiss={() => {}} />
							)}
							{doomLoopMessage && !isProcessing && <DoomLoopAlert message={doomLoopMessage} onRetry={handleRetry} onDismiss={() => {}} />}
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

							{!isProcessing && committedMessages.length > 0 && committedMessages.at(-1)?.role === 'assistant' && (
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

							<div ref={anchorReference} className="h-px shrink-0" aria-hidden />
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>

				<div
					className="
						pointer-events-none absolute inset-x-0 bottom-0 z-10 h-6 bg-linear-to-t
						from-bg-secondary to-transparent opacity-0 transition-opacity duration-200
						group-data-can-scroll-down/scroll:opacity-100
					"
				/>

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

			<div className="relative shrink-0 border-t border-border p-2">
				{/* Render outside the clipped input shell so the suggestions can overflow normally. */}
				{isFileMentionOpen && (
					<FileMentionDropdown results={fileMentionResults} selectedIndex={fileMentionSelectedIndex} onSelect={selectMentionFile} />
				)}
				<div className="flex flex-col gap-2">
					<Collapsible open={queuedMessages.length > 0} className="relative z-20 overflow-visible">
						{queuedMessages.length > 0 && (
							<QueuedSteeringStrip
								messages={queuedMessages}
								localOnlyMessageIds={localOnlyMessageIds}
								onRemoveMessage={handleRemoveQueuedMessage}
							/>
						)}
					</Collapsible>
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
												size-2 rounded-full bg-error transition-opacity duration-150
												ease-out
											`,
											speechToText.isMicrophoneReady ? 'animate-pulse opacity-100' : 'opacity-0',
										)}
									/>
								</div>
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
								<AgentModeSelector mode={agentMode} onModeChange={setAgentMode} disabled={false} />
								<ModelSelectorDropdown selectedModel={selectedModel} onSelectModel={setSelectedModel} disabled={false} />
								<div className="flex flex-1 shrink-0 items-center justify-end gap-0.5">
									<ContextRing tokensUsed={contextTokensUsed} contextWindow={getModelLimits(selectedModel).contextWindow} />
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
									{isProcessing && (
										<button
											type="button"
											onClick={handleCancel}
											disabled={isStopPending || !isConnected}
											className={cn(
												`
													inline-flex cursor-pointer items-center justify-center rounded-md
													p-1
												`,
												'text-xs font-medium text-error transition-colors',
												isStopPending ? 'cursor-wait opacity-70' : isConnected ? 'hover:bg-error/10' : 'cursor-not-allowed opacity-40',
											)}
											aria-label={isStopPending ? 'Stopping' : 'Stop'}
										>
											{isStopPending ? <Spinner className="size-4" /> : <Square className="size-4" />}
										</button>
									)}
									<button
										type="button"
										onClick={() => void handleSubmit()}
										disabled={!hasContent}
										className={cn(
											'inline-flex items-center justify-center rounded-md p-1',
											'text-xs font-medium transition-colors',
											hasContent
												? `
													cursor-pointer bg-accent text-white
													hover:bg-accent-hover
												`
												: 'cursor-not-allowed text-text-secondary opacity-40',
										)}
										aria-label={isProcessing ? 'Queue message' : 'Send message'}
									>
										<ArrowUp className="size-4" />
									</button>
								</div>
							</div>
						)}
					</div>
				</div>
			</div>

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
