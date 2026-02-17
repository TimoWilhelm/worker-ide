/**
 * useProjectSocket Hook
 *
 * Hook for managing the project WebSocket connection.
 * Handles HMR update notifications, real-time collaboration,
 * server error/log forwarding, and file edit broadcasts.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { useShallow } from 'zustand/react/shallow';

import { connectProjectSocket } from '@/lib/api-client';
import { useStore } from '@/lib/store';

import type { ClientMessage } from '@shared/ws-messages';

// =============================================================================
// Types
// =============================================================================

interface UseProjectSocketOptions {
	projectId: string;
	enabled?: boolean;
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for connecting to the project WebSocket and handling updates.
 *
 * Uses refs exclusively for callbacks to ensure the WebSocket connection
 * is only created/destroyed when projectId or enabled changes — never
 * due to callback identity churn.
 */
/**
 * Global ref for the WebSocket send function.
 * Used by the editor to send cursor updates without prop drilling.
 */
export const projectSocketSendReference: { current: ((data: ClientMessage) => void) | undefined } = { current: undefined };

export function useProjectSocket({ projectId, enabled = true }: UseProjectSocketOptions) {
	const queryClient = useQueryClient();
	const storeActions = useStore(
		useShallow((state) => ({
			setParticipants: state.setParticipants,
			addParticipant: state.addParticipant,
			removeParticipant: state.removeParticipant,
			updateParticipant: state.updateParticipant,
			setLocalParticipantId: state.setLocalParticipantId,
			setLocalParticipantColor: state.setLocalParticipantColor,
			setConnected: state.setConnected,
			activeFile: state.activeFile,
		})),
	);

	// All mutable state in refs — none of these cause re-connection
	const reconnectTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const reconnectAttemptsReference = useRef(0);
	const connectionReference = useRef<import('@/lib/api-client').ProjectSocketConnection | undefined>(undefined);
	const queryClientReference = useRef(queryClient);
	const storeActionsReference = useRef(storeActions);
	const projectIdReference = useRef(projectId);
	const isMountedReference = useRef(true);

	// Keep refs in sync (runs every render but does NOT trigger effects)
	useEffect(() => {
		queryClientReference.current = queryClient;
		storeActionsReference.current = storeActions;
		projectIdReference.current = projectId;
	});

	// Single effect: connect on mount / when projectId or enabled changes
	useEffect(() => {
		if (!enabled) return;

		isMountedReference.current = true;

		const doConnect = () => {
			// Bail out if unmounted between reconnect timeout and execution
			if (!isMountedReference.current) return;

			// Tear down any existing connection
			connectionReference.current?.cleanup();
			if (reconnectTimeoutReference.current) {
				clearTimeout(reconnectTimeoutReference.current);
				reconnectTimeoutReference.current = undefined;
			}

			connectionReference.current = connectProjectSocket(
				projectId,
				// onMessage — reads latest refs each invocation
				(message) => {
					const { setParticipants, addParticipant, removeParticipant, updateParticipant, setLocalParticipantId, setLocalParticipantColor } =
						storeActionsReference.current;
					const queryClientCurrent = queryClientReference.current;
					const projectIdCurrent = projectIdReference.current;

					switch (message.type) {
						case 'update':
						case 'full-reload': {
							// Invalidate queries for updated file paths, but skip
							// the currently active file — its content is managed
							// locally by the editor and refetching would race with
							// unsaved edits.
							const activeFilePath = storeActionsReference.current.activeFile;
							for (const update of message.updates) {
								if (update.path === activeFilePath) continue;
								void queryClientCurrent.invalidateQueries({
									queryKey: ['file', projectIdCurrent, update.path],
								});
							}
							// Refresh the file list so newly created/deleted files
							// by the AI agent or collaborators appear immediately.
							void queryClientCurrent.invalidateQueries({
								queryKey: ['files', projectIdCurrent],
							});
							// The preview iframe has its own HMR WebSocket client
							// that handles full-reload and CSS hot-swap internally,
							// so no postMessage is needed here.
							// Notify the log buffer that a rebuild occurred
							globalThis.dispatchEvent(new CustomEvent('rebuild'));
							break;
						}
						case 'collab-state': {
							setParticipants(message.participants);
							if ('selfId' in message && typeof message.selfId === 'string') {
								setLocalParticipantId(message.selfId);
							}
							if ('selfColor' in message && typeof message.selfColor === 'string') {
								setLocalParticipantColor(message.selfColor);
							}
							break;
						}
						case 'participant-joined': {
							addParticipant(message.participant);
							break;
						}
						case 'participant-left': {
							removeParticipant(message.id);
							break;
						}
						case 'server-error': {
							const errorEvent = new CustomEvent('server-error', { detail: message.error });
							globalThis.dispatchEvent(errorEvent);
							break;
						}

						case 'server-logs': {
							const logsEvent = new CustomEvent('server-logs', { detail: message.logs });
							globalThis.dispatchEvent(logsEvent);
							break;
						}
						case 'cursor-updated': {
							updateParticipant(message.id, {
								file: message.file,
								cursor: message.cursor,
								selection: message.selection,
							});
							break;
						}
						case 'git-status-changed': {
							// Invalidate git queries so the UI refreshes
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-status', projectIdCurrent],
							});
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-branches', projectIdCurrent],
							});
							void queryClientCurrent.invalidateQueries({
								queryKey: ['git-log', projectIdCurrent],
							});
							break;
						}
						case 'pong':
						case 'file-edited': {
							// Handled elsewhere or ignored
							break;
						}
					}
				},
				// onClose — only fires for unexpected disconnects (intentional
				// closes are suppressed by the connectProjectSocket cleanup function)
				() => {
					if (!isMountedReference.current) return;

					storeActionsReference.current.setConnected(false);
					const maxAttempts = 10;
					const baseDelay = 2000;
					if (reconnectAttemptsReference.current < maxAttempts) {
						const delay = Math.min(baseDelay * 2 ** reconnectAttemptsReference.current, 30_000);
						reconnectTimeoutReference.current = setTimeout(() => {
							reconnectAttemptsReference.current++;
							doConnect();
						}, delay);
					}
				},
				// onOpen
				() => {
					storeActionsReference.current.setConnected(true);
					reconnectAttemptsReference.current = 0;
					projectSocketSendReference.current = connectionReference.current?.send;
				},
			);
		};

		doConnect();

		return () => {
			isMountedReference.current = false;
			connectionReference.current?.cleanup();
			connectionReference.current = undefined;
			projectSocketSendReference.current = undefined;
			if (reconnectTimeoutReference.current) {
				clearTimeout(reconnectTimeoutReference.current);
				reconnectTimeoutReference.current = undefined;
			}
			storeActionsReference.current.setConnected(false);
		};
		// Intentionally only depends on projectId and enabled.
		// All other values are read from refs inside the closures.
	}, [enabled, projectId]);
}
