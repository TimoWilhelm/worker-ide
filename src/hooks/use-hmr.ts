/**
 * useHMR Hook
 *
 * Hook for managing HMR WebSocket connection.
 */

import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';

import { connectHMR, type HMRMessage } from '@/lib/api-client';
import { useStore } from '@/lib/store';

// =============================================================================
// Types
// =============================================================================

interface UseHMROptions {
	projectId: string;
	enabled?: boolean;
}

interface WireParticipant {
	id: string;
	color: string;
	file: string | null;
}

// =============================================================================
// Helpers
// =============================================================================

function isString(value: unknown): value is string {
	return typeof value === 'string';
}

function isStringOrNull(value: unknown): value is string | null {
	return value === null || typeof value === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function isWireParticipant(value: unknown): value is WireParticipant {
	if (!isRecord(value)) return false;
	return isString(value.id) && isString(value.color) && isStringOrNull(value.file);
}

function isParticipantArray(value: unknown): value is WireParticipant[] {
	return Array.isArray(value) && value.every((item: unknown) => isWireParticipant(item));
}

// =============================================================================
// Hook
// =============================================================================

/**
 * Hook for connecting to HMR WebSocket and handling updates.
 */
export function useHMR({ projectId, enabled = true }: UseHMROptions) {
	const queryClient = useQueryClient();
	const reconnectTimeoutReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const reconnectAttemptsReference = useRef(0);
	const cleanupReference = useRef<(() => void) | undefined>(undefined);

	// Store actions
	const { setConnected, setParticipants, addParticipant, removeParticipant } = useStore();

	// Ref to hold the connect function, breaking the circular dependency
	// between handleClose and connect
	const connectReference = useRef<() => void>(undefined);

	// Handle incoming HMR messages
	const handleMessage = useCallback(
		(message: HMRMessage) => {
			switch (message.type) {
				case 'update':
				case 'full-reload': {
					const path = isString(message.path) ? message.path : '';

					// Invalidate file content cache for the changed file
					void queryClient.invalidateQueries({ queryKey: ['file', projectId, path] });

					// For CSS updates, we could do hot-swapping
					// For full-reload, the preview iframe will handle it
					if (message.type === 'full-reload') {
						// Notify preview iframe to reload
						const iframe = document.querySelector<HTMLIFrameElement>('iframe[data-preview]');
						iframe?.contentWindow?.postMessage({ type: 'hmr:reload' }, '*');
					}
					break;
				}

				case 'participants': {
					if (isParticipantArray(message.participants)) {
						setParticipants(
							message.participants.map((participant) => ({
								id: participant.id,
								color: participant.color,
								file: participant.file,
								// eslint-disable-next-line unicorn/no-null -- Participant type uses null
								cursor: null,
								// eslint-disable-next-line unicorn/no-null -- Participant type uses null
								selection: null,
							})),
						);
					}
					break;
				}

				case 'join': {
					if (isWireParticipant(message.participant)) {
						addParticipant({
							id: message.participant.id,
							color: message.participant.color,
							file: message.participant.file,
							// eslint-disable-next-line unicorn/no-null -- Participant type uses null
							cursor: null,
							// eslint-disable-next-line unicorn/no-null -- Participant type uses null
							selection: null,
						});
					}
					break;
				}

				case 'leave': {
					if (isString(message.participantId)) {
						removeParticipant(message.participantId);
					}
					break;
				}

				case 'pong': {
					// Keep-alive response, no action needed
					break;
				}

				default: {
					console.log('[HMR] Unknown message type:', message.type);
				}
			}
		},
		[queryClient, projectId, setParticipants, addParticipant, removeParticipant],
	);

	// Handle connection close
	const handleClose = useCallback(() => {
		setConnected(false);

		// Exponential backoff for reconnection
		const maxAttempts = 10;
		const baseDelay = 1000;

		if (reconnectAttemptsReference.current < maxAttempts) {
			const delay = Math.min(baseDelay * Math.pow(2, reconnectAttemptsReference.current), 30_000);
			reconnectTimeoutReference.current = setTimeout(() => {
				reconnectAttemptsReference.current++;
				connectReference.current?.();
			}, delay);
		}
	}, [setConnected]);

	// Connect to HMR WebSocket
	const connect = useCallback(() => {
		if (!enabled) return;

		// Clean up existing connection
		cleanupReference.current?.();

		// Create new connection
		cleanupReference.current = connectHMR(projectId, handleMessage, handleClose);
		setConnected(true);
		reconnectAttemptsReference.current = 0;
	}, [projectId, enabled, handleMessage, handleClose, setConnected]);

	// Keep connect ref in sync
	useEffect(() => {
		connectReference.current = connect;
	}, [connect]);

	// Set up connection on mount
	useEffect(() => {
		if (!enabled) return;

		connect();

		return () => {
			cleanupReference.current?.();
			if (reconnectTimeoutReference.current) {
				clearTimeout(reconnectTimeoutReference.current);
			}
			setConnected(false);
		};
	}, [enabled, connect, setConnected]);

	// Manual reconnect function
	const reconnect = useCallback(() => {
		reconnectAttemptsReference.current = 0;
		connect();
	}, [connect]);

	return { reconnect };
}
