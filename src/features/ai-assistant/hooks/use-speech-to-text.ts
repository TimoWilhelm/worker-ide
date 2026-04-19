import { useCallback, useEffect, useRef, useState } from 'react';

import { toast } from '@/components/ui/toast-store';

import { createAudioStreamSender } from '../lib/audio-stream-sender';

const pcmProcessorUrl = new URL('../lib/pcm-processor.js', import.meta.url).href;

type MicrophonePermission = 'default' | 'granted' | 'denied' | 'unsupported';
const AUTO_STOP_SILENCE_MS = 1500;
const AMPLITUDE_BUFFER_SIZE = 32;
const AMPLITUDE_INTERVAL_MS = 100;

function mapMicrophonePermissionState(state: PermissionState): MicrophonePermission {
	return state === 'prompt' ? 'default' : state;
}

async function readMicrophonePermission(): Promise<MicrophonePermission | undefined> {
	if (!isMicrophoneSupported() || !('permissions' in navigator)) {
		return undefined;
	}

	try {
		// 'microphone' is a valid PermissionName but not in all TS lib typings
		const descriptor: PermissionDescriptor = { name: 'microphone' as PermissionName }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- 'microphone' is valid but not in TS lib
		const status = await navigator.permissions.query(descriptor);
		return mapMicrophonePermissionState(status.state);
	} catch {
		return undefined;
	}
}

function isMicrophonePermissionError(error: unknown): boolean {
	if (error instanceof DOMException) {
		return error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError';
	}

	if (error instanceof Error) {
		return error.message.includes('Permission') || error.message.includes('NotAllowed');
	}

	return false;
}

interface ParsedSttMessage {
	type: string | undefined;
	isFinal: boolean;
	speechFinal: boolean;
	transcript: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null;
}

function parseSttMessage(value: unknown): ParsedSttMessage | undefined {
	if (!isRecord(value)) {
		return undefined;
	}

	const type = typeof value.type === 'string' ? value.type : undefined;
	const isFinal = value.is_final === true;
	const speechFinal = value.speech_final === true;
	const channel = value.channel;
	if (!isRecord(channel)) {
		return { type, isFinal, speechFinal, transcript: '' };
	}

	const alternatives = channel.alternatives;
	if (!Array.isArray(alternatives)) {
		return { type, isFinal, speechFinal, transcript: '' };
	}

	const firstAlternative = alternatives[0];
	if (!isRecord(firstAlternative)) {
		return { type, isFinal, speechFinal, transcript: '' };
	}

	const transcript = typeof firstAlternative.transcript === 'string' ? firstAlternative.transcript : '';
	return { type, isFinal, speechFinal, transcript };
}

interface SpeechToTextResult {
	microphonePermission: MicrophonePermission;
	needsPermissionApproval: boolean;
	isAwaitingPermission: boolean;
	isRecording: boolean;
	isMicrophoneReady: boolean;
	interimTranscript: string;
	finalTranscript: string;
	amplitudes: number[];
	start: () => Promise<void>;
	stop: () => string;
}

function isMicrophoneSupported(): boolean {
	return 'mediaDevices' in navigator && 'getUserMedia' in navigator.mediaDevices;
}

function getInitialMicrophonePermission(): MicrophonePermission {
	if (!isMicrophoneSupported()) return 'unsupported';
	return 'default';
}

let workletReadyPromise: Promise<void> | undefined;

function ensureWorkletPreloaded(): Promise<void> {
	if (workletReadyPromise) return workletReadyPromise;
	workletReadyPromise = new AudioContext({ sampleRate: 16_000 }).audioWorklet.addModule(pcmProcessorUrl).catch(() => {
		workletReadyPromise = undefined;
	});
	return workletReadyPromise ?? Promise.resolve();
}

export function useSpeechToText({
	projectId,
	onAutoStop,
}: {
	projectId: string;
	onAutoStop?: (transcript: string) => void;
}): SpeechToTextResult {
	const [microphonePermission, setMicrophonePermission] = useState<MicrophonePermission>(getInitialMicrophonePermission);
	const [isAwaitingPermission, setIsAwaitingPermission] = useState(false);
	const [isRecording, setIsRecording] = useState(false);
	const [isMicrophoneReady, setIsMicrophoneReady] = useState(false);
	const [interimTranscript, setInterimTranscript] = useState('');
	const [finalTranscript, setFinalTranscript] = useState('');
	const [amplitudes, setAmplitudes] = useState<number[]>([]);

	const webSocketReference = useRef<WebSocket | undefined>(undefined);
	const audioContextReference = useRef<AudioContext | undefined>(undefined);
	const mediaStreamReference = useRef<MediaStream | undefined>(undefined);
	const workletNodeReference = useRef<AudioWorkletNode | undefined>(undefined);
	const sourceNodeReference = useRef<MediaStreamAudioSourceNode | undefined>(undefined);
	const finalTranscriptReference = useRef('');
	const silenceTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
	const amplitudePeakReference = useRef(0);
	const amplitudeTimerReference = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
	const onAutoStopReference = useRef(onAutoStop);
	const audioStreamSenderReference = useRef<ReturnType<typeof createAudioStreamSender> | undefined>(undefined);

	if (audioStreamSenderReference.current === undefined) {
		audioStreamSenderReference.current = createAudioStreamSender();
	}

	useEffect(() => {
		onAutoStopReference.current = onAutoStop;
	}, [onAutoStop]);

	useEffect(() => {
		if (!isMicrophoneSupported()) return;
		void ensureWorkletPreloaded();
	}, []);

	useEffect(() => {
		if (!isMicrophoneSupported()) return;

		const abortController = new AbortController();
		const syncMicrophonePermission = () => {
			void readMicrophonePermission()
				.then((status) => {
					if (abortController.signal.aborted || !status) return;
					setMicrophonePermission(status);
				})
				.catch(() => {
					// Permissions API not supported for microphone — stay at 'default'
				});
		};
		const handleWindowFocus = () => {
			syncMicrophonePermission();
		};
		const handleVisibilityChange = () => {
			if (document.visibilityState !== 'visible') return;
			syncMicrophonePermission();
		};

		syncMicrophonePermission();
		window.addEventListener('focus', handleWindowFocus);
		document.addEventListener('visibilitychange', handleVisibilityChange);

		if (!('permissions' in navigator)) {
			return () => {
				abortController.abort();
				window.removeEventListener('focus', handleWindowFocus);
				document.removeEventListener('visibilitychange', handleVisibilityChange);
			};
		}

		// 'microphone' is a valid PermissionName but not in all TS lib typings
		const descriptor: PermissionDescriptor = { name: 'microphone' as PermissionName }; // eslint-disable-line @typescript-eslint/consistent-type-assertions -- 'microphone' is valid but not in TS lib
		void navigator.permissions
			.query(descriptor)
			.then((status) => {
				if (abortController.signal.aborted) return;

				status.addEventListener(
					'change',
					() => {
						setMicrophonePermission(mapMicrophonePermissionState(status.state));
					},
					{
						signal: abortController.signal,
					},
				);
			})
			.catch(() => {
				// Permissions API not supported for microphone — stay at 'default'
			});

		return () => {
			abortController.abort();
			window.removeEventListener('focus', handleWindowFocus);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
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

		if (amplitudeTimerReference.current !== undefined) {
			clearInterval(amplitudeTimerReference.current);
			amplitudeTimerReference.current = undefined;
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
		audioStreamSenderReference.current?.reset();
	}, []);

	const start = useCallback(async () => {
		setInterimTranscript('');
		setFinalTranscript('');
		setAmplitudes([]);
		finalTranscriptReference.current = '';
		audioStreamSenderReference.current?.reset();
		amplitudePeakReference.current = 0;

		setIsAwaitingPermission(microphonePermission === 'default');
		setIsRecording(true);
		setIsMicrophoneReady(false);

		try {
			const triggerAutoStop = () => {
				const accumulated = finalTranscriptReference.current;
				if (accumulated) {
					cleanup();
					onAutoStopReference.current?.(accumulated);
					setIsRecording(false);
					setIsMicrophoneReady(false);
				}
			};

			const resetSilenceTimer = () => {
				if (silenceTimerReference.current !== undefined) {
					clearTimeout(silenceTimerReference.current);
				}
				silenceTimerReference.current = setTimeout(triggerAutoStop, AUTO_STOP_SILENCE_MS);
			};

			const protocol = globalThis.location.protocol === 'https:' ? 'wss:' : 'ws:';
			const wsUrl = `${protocol}//${globalThis.location.host}/p/${projectId}/api/stt/ws`;
			const webSocket = new WebSocket(wsUrl);
			webSocket.binaryType = 'arraybuffer';
			webSocketReference.current = webSocket;
			audioStreamSenderReference.current?.attachWebSocket(webSocket);

			webSocket.addEventListener('open', () => {
				audioStreamSenderReference.current?.markTransportOpen();
			});

			webSocket.addEventListener('message', (event: MessageEvent) => {
				try {
					const parsedMessage = parseSttMessage(JSON.parse(String(event.data)));
					if (!parsedMessage) return;
					if (parsedMessage.type === 'stt:ready') {
						audioStreamSenderReference.current?.markReady();
						return;
					}

					if (parsedMessage.type === 'UtteranceEnd') {
						triggerAutoStop();
						return;
					}

					const transcript = parsedMessage.transcript;

					if (parsedMessage.isFinal && transcript) {
						setFinalTranscript((previous) => {
							const updated = previous ? `${previous} ${transcript}` : transcript;
							finalTranscriptReference.current = updated;
							return updated;
						});
						setInterimTranscript('');

						if (parsedMessage.speechFinal) {
							if (silenceTimerReference.current !== undefined) {
								clearTimeout(silenceTimerReference.current);
								silenceTimerReference.current = undefined;
							}
							triggerAutoStop();
						} else {
							resetSilenceTimer();
						}
					} else if (transcript) {
						setInterimTranscript(transcript);
						if (silenceTimerReference.current !== undefined) {
							resetSilenceTimer();
						}
					}
				} catch {
					// Ignore non-JSON messages
				}
			});

			webSocket.addEventListener('error', () => {
				toast.error('Connection to transcription service failed');
				setIsAwaitingPermission(false);
				setIsRecording(false);
				cleanup();
			});

			webSocket.addEventListener('close', () => {
				setIsAwaitingPermission(false);
				setIsRecording(false);
				setIsMicrophoneReady(false);
			});

			const audioContext = new AudioContext({ sampleRate: 16_000 });
			audioContextReference.current = audioContext;
			const audioWorkletReadyPromise = audioContext.audioWorklet.addModule(pcmProcessorUrl).then(() => audioContext.resume());

			const streamPromise = navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					sampleRate: 16_000,
					echoCancellation: true,
					noiseSuppression: true,
				},
			});

			const [stream] = await Promise.all([streamPromise, audioWorkletReadyPromise]);
			if (webSocketReference.current !== webSocket) {
				for (const track of stream.getTracks()) {
					track.stop();
				}
				if (audioContext.state !== 'closed') {
					void audioContext.close();
				}
				return;
			}
			mediaStreamReference.current = stream;
			setIsAwaitingPermission(false);
			setIsMicrophoneReady(true);

			const source = audioContext.createMediaStreamSource(stream);
			sourceNodeReference.current = source;
			const workletNode = new AudioWorkletNode(audioContext, 'pcm-processor');
			workletNodeReference.current = workletNode;

			source.connect(workletNode);
			workletNode.connect(audioContext.destination);

			workletNode.port.addEventListener('message', (event: MessageEvent<{ pcm: ArrayBuffer; peak: number }>) => {
				const { pcm, peak } = event.data;

				if (peak > amplitudePeakReference.current) {
					amplitudePeakReference.current = peak;
				}

				audioStreamSenderReference.current?.enqueue(pcm);
			});
			workletNode.port.start();

			amplitudeTimerReference.current = setInterval(() => {
				const peak = amplitudePeakReference.current;
				amplitudePeakReference.current = 0;
				setAmplitudes((previous) => {
					const next = [...previous, peak];
					return next.length > AMPLITUDE_BUFFER_SIZE ? next.slice(-AMPLITUDE_BUFFER_SIZE) : next;
				});
			}, AMPLITUDE_INTERVAL_MS);
		} catch (caughtError) {
			const message = caughtError instanceof Error ? caughtError.message : 'Failed to start recording';
			if (isMicrophonePermissionError(caughtError)) {
				const permission = await readMicrophonePermission();
				setMicrophonePermission(permission ?? 'default');
				if (permission === 'denied') {
					toast.error('Microphone permission denied');
				}
			} else {
				toast.error(message);
			}
			setIsAwaitingPermission(false);
			setIsRecording(false);
			setIsMicrophoneReady(false);
			cleanup();
		}
	}, [projectId, cleanup, microphonePermission]);

	const stop = useCallback((): string => {
		setIsAwaitingPermission(false);
		setIsRecording(false);
		setIsMicrophoneReady(false);
		setInterimTranscript('');
		setAmplitudes([]);
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
		needsPermissionApproval: isAwaitingPermission,
		isAwaitingPermission,
		isRecording,
		isMicrophoneReady,
		interimTranscript,
		finalTranscript,
		amplitudes,
		start,
		stop,
	};
}
