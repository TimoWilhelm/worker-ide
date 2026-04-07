/**
 * Speech-to-Text Hook
 *
 * Captures microphone audio via AudioWorklet (linear16 PCM at 16 kHz),
 * streams it over a WebSocket to the backend `/api/stt/ws` route which
 * uses `env.AI.run("@cf/deepgram/nova-3", ..., { websocket: true })`.
 *
 * Receives JSON transcript messages with `interim_results` support for
 * real-time partial transcripts while the user is still speaking.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const pcmProcessorUrl = new URL('../lib/pcm-processor.js', import.meta.url).href;

type MicrophonePermission = 'default' | 'granted' | 'denied' | 'unsupported';

/** Delay (ms) after the last final transcript before auto-stopping. */
const AUTO_STOP_SILENCE_MS = 1500;

interface SpeechToTextResult {
	/** Microphone permission state */
	microphonePermission: MicrophonePermission;
	/** Whether the microphone is actively recording */
	isRecording: boolean;
	/** Partial transcript while the user is still speaking */
	interimTranscript: string;
	/** Accumulated final transcript from completed utterances */
	finalTranscript: string;
	/** Error message if something went wrong */
	error: string | undefined;
	/** Start recording */
	start: () => Promise<void>;
	/** Stop recording and return accumulated final transcript */
	stop: () => string;
}

function isMicrophoneSupported(): boolean {
	return 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices;
}

function getInitialMicrophonePermission(): MicrophonePermission {
	if (!isMicrophoneSupported()) return 'unsupported';
	return 'default';
}

export function useSpeechToText({
	projectId,
	onAutoStop,
}: {
	projectId: string;
	onAutoStop?: (transcript: string) => void;
}): SpeechToTextResult {
	const [microphonePermission, setMicrophonePermission] = useState<MicrophonePermission>(getInitialMicrophonePermission);
	const [isRecording, setIsRecording] = useState(false);
	const [interimTranscript, setInterimTranscript] = useState('');
	const [finalTranscript, setFinalTranscript] = useState('');
	const [error, setError] = useState<string | undefined>();

	const webSocketReference = useRef<WebSocket | undefined>(undefined);
	const audioContextReference = useRef<AudioContext | undefined>(undefined);
	const mediaStreamReference = useRef<MediaStream | undefined>(undefined);
	const workletNodeReference = useRef<AudioWorkletNode | undefined>(undefined);
	const sourceNodeReference = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
	const finalTranscriptReference = useRef('');
	const silenceTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const onAutoStopReference = useRef(onAutoStop);

	useEffect(() => {
		onAutoStopReference.current = onAutoStop;
	}, [onAutoStop]);

	// Query microphone permission on mount and listen for changes
	useEffect(() => {
		if (!isMicrophoneSupported()) return;

		const abortController = new AbortController();

		// 'microphone' is a valid PermissionName but not in all TS lib typings
		const descriptor: PermissionDescriptor = { name: 'microphone' as PermissionName }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- 'microphone' is valid but not in TS lib
		void navigator.permissions
			.query(descriptor)
			.then((status) => {
				if (abortController.signal.aborted) return;

				const mapState = () => (status.state === 'prompt' ? 'default' : status.state);
				setMicrophonePermission(mapState());

				status.addEventListener('change', () => setMicrophonePermission(mapState()), {
					signal: abortController.signal,
				});
			})
			.catch(() => {
				// Permissions API not supported for microphone — stay at 'default'
			});

		return () => {
			abortController.abort();
		};
	}, []);

	useEffect(() => {
		finalTranscriptReference.current = finalTranscript;
	}, [finalTranscript]);

	const cleanup = useCallback(() => {
		if (silenceTimerReference.current !== undefined) {
			clearTimeout(silenceTimerReference.current);
			silenceTimerReference.current = undefined;
		}

		const webSocket = webSocketReference.current;
		if (webSocket && (webSocket.readyState === WebSocket.OPEN || webSocket.readyState === WebSocket.CONNECTING)) {
			webSocket.close(1000, 'Recording stopped');
		}
		webSocketReference.current = undefined;

		const workletNode = workletNodeReference.current;
		if (workletNode) {
			workletNode.disconnect();
		}
		workletNodeReference.current = undefined;

		const sourceNode = sourceNodeReference.current;
		if (sourceNode) {
			sourceNode.disconnect();
		}
		sourceNodeReference.current = undefined;

		const audioContext = audioContextReference.current;
		if (audioContext && audioContext.state !== 'closed') {
			void audioContext.close();
		}
		audioContextReference.current = undefined;

		const mediaStream = mediaStreamReference.current;
		if (mediaStream) {
			for (const track of mediaStream.getTracks()) {
				track.stop();
			}
		}
		mediaStreamReference.current = undefined;
	}, []);

	const start = useCallback(async () => {
		setError(undefined);
		setInterimTranscript('');
		setFinalTranscript('');
		finalTranscriptReference.current = '';

		try {
			// Request microphone access
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					sampleRate: 16_000,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});
			mediaStreamReference.current = stream;

			// AudioContext at 16 kHz for linear16 PCM expected by Nova-3
			const audioContext = new AudioContext({ sampleRate: 16_000 });
			audioContextReference.current = audioContext;

			// Load worklet processor (URL resolved by Vite ?url import)
			await audioContext.audioWorklet.addModule(pcmProcessorUrl);

			const source = audioContext.createMediaStreamSource(stream);
			sourceNodeReference.current = source;
			const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
			workletNodeReference.current = workletNode;

			// Open WebSocket to backend STT route
			const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
			const wsUrl = `${protocol}//${globalThis.location.host}/p/${projectId}/api/stt/ws`;
			const webSocket = new WebSocket(wsUrl);
			webSocket.binaryType = 'arraybuffer';
			webSocketReference.current = webSocket;

			webSocket.addEventListener('open', () => {
				source.connect(workletNode);
				workletNode.connect(audioContext.destination);

				workletNode.port.addEventListener('message', (event: MessageEvent<ArrayBuffer>) => {
					if (webSocket.readyState === WebSocket.OPEN) {
						webSocket.send(event.data);
					}
				});
				workletNode.port.start();

				setIsRecording(true);
			});

			webSocket.addEventListener('message', (event: MessageEvent) => {
				try {
					const data: unknown = JSON.parse(String(event.data));
					if (!data || typeof data !== 'object') return;
					// eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- parsing external Deepgram JSON
					const message = data as {
						is_final?: boolean;
						speech_final?: boolean;
						channel?: { alternatives?: Array<{ transcript?: string }> };
					};
					const transcript = message.channel?.alternatives?.[0]?.transcript ?? '';

					if (message.is_final && transcript) {
						setFinalTranscript((previous) => {
							const updated = previous ? `${previous} ${transcript}` : transcript;
							finalTranscriptReference.current = updated;
							return updated;
						});
						setInterimTranscript('');

						// Reset silence timer — speaker is still active.
						// When no new final transcript arrives within the
						// threshold, auto-stop recording and invoke onAutoStop.
						if (silenceTimerReference.current !== undefined) {
							clearTimeout(silenceTimerReference.current);
						}
						silenceTimerReference.current = setTimeout(() => {
							const accumulated = finalTranscriptReference.current;
							if (accumulated) {
								cleanup();
								onAutoStopReference.current?.(accumulated);
								setIsRecording(false);
							}
						}, AUTO_STOP_SILENCE_MS);
					} else if (transcript) {
						setInterimTranscript(transcript);

						// Interim speech resets the silence timer — restart it so
						// auto-stop still fires if no further final transcripts arrive.
						if (silenceTimerReference.current !== undefined) {
							clearTimeout(silenceTimerReference.current);
							silenceTimerReference.current = setTimeout(() => {
								const accumulated = finalTranscriptReference.current;
								if (accumulated) {
									cleanup();
									onAutoStopReference.current?.(accumulated);
									setIsRecording(false);
								}
							}, AUTO_STOP_SILENCE_MS);
						}
					}
				} catch {
					// Ignore non-JSON messages
				}
			});

			webSocket.addEventListener('error', () => {
				setError('Connection to transcription service failed');
				setIsRecording(false);
				cleanup();
			});

			webSocket.addEventListener('close', () => {
				setIsRecording(false);
			});
		} catch (caughtError) {
			const message = caughtError instanceof Error ? caughtError.message : 'Failed to start recording';
			if (message.includes('Permission') || message.includes('NotAllowed')) {
				setMicrophonePermission('denied');
				setError('Microphone permission denied');
			} else {
				setError(message);
			}
			cleanup();
		}
	}, [projectId, cleanup]);

	const stop = useCallback((): string => {
		setIsRecording(false);
		setInterimTranscript('');
		cleanup();
		return finalTranscriptReference.current;
	}, [cleanup]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			cleanup();
		};
	}, [cleanup]);

	return {
		microphonePermission,
		isRecording,
		interimTranscript,
		finalTranscript,
		error,
		start,
		stop,
	};
}
