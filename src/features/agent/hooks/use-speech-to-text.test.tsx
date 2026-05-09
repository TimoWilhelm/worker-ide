import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useSpeechToText } from './use-speech-to-text';

const { toastError } = vi.hoisted(() => ({
	toastError: vi.fn(),
}));

vi.mock('@/components/ui/toast-store', () => ({
	toast: {
		error: toastError,
	},
}));

vi.mock('../lib/audio-stream-sender', () => ({
	createAudioStreamSender: () => ({
		attachWebSocket: vi.fn(),
		markTransportOpen: vi.fn(),
		markReady: vi.fn(),
		enqueue: vi.fn(),
		reset: vi.fn(),
	}),
}));

class MockWebSocket {
	static OPEN = 1;
	static CONNECTING = 0;

	readyState = MockWebSocket.CONNECTING;
	binaryType = 'blob';

	addEventListener(): void {}

	close(): void {
		this.readyState = 3;
	}
}

class MockAudioContext {
	state: AudioContextState = 'running';
	audioWorklet = {
		addModule: vi.fn(async () => {}),
	};

	constructor(_options?: AudioContextOptions) {}

	async resume(): Promise<void> {}

	async close(): Promise<void> {
		this.state = 'closed';
	}
}

interface MockPermissionStatus {
	state: PermissionState;
	addEventListener: ReturnType<typeof vi.fn>;
	removeEventListener: ReturnType<typeof vi.fn>;
}

describe('useSpeechToText', () => {
	const originalMediaDevices = navigator.mediaDevices;
	const originalPermissions = navigator.permissions;
	const OriginalWebSocket = globalThis.WebSocket;
	const OriginalAudioContext = globalThis.AudioContext;

	let permissionStatus: MockPermissionStatus;
	let permissionChangeListener: EventListener | undefined;
	let getUserMediaMock: ReturnType<typeof vi.fn>;
	let queryMock: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		toastError.mockReset();
		permissionChangeListener = undefined;
		permissionStatus = {
			state: 'prompt',
			addEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && typeof listener === 'function') {
					permissionChangeListener = listener;
				}
			}),
			removeEventListener: vi.fn((eventName: string, listener: EventListenerOrEventListenerObject) => {
				if (eventName === 'change' && listener === permissionChangeListener) {
					permissionChangeListener = undefined;
				}
			}),
		};
		getUserMediaMock = vi.fn();
		queryMock = vi.fn(async () => permissionStatus);

		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: { getUserMedia: getUserMediaMock },
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: { query: queryMock },
		});
		Object.defineProperty(globalThis, 'WebSocket', {
			configurable: true,
			value: MockWebSocket,
		});
		Object.defineProperty(globalThis, 'AudioContext', {
			configurable: true,
			value: MockAudioContext,
		});
	});

	afterEach(() => {
		Object.defineProperty(navigator, 'mediaDevices', {
			configurable: true,
			value: originalMediaDevices,
		});
		Object.defineProperty(navigator, 'permissions', {
			configurable: true,
			value: originalPermissions,
		});
		Object.defineProperty(globalThis, 'WebSocket', {
			configurable: true,
			value: OriginalWebSocket,
		});
		Object.defineProperty(globalThis, 'AudioContext', {
			configurable: true,
			value: OriginalAudioContext,
		});
	});

	it('keeps microphone permission at default when the browser prompt is dismissed', async () => {
		getUserMediaMock.mockRejectedValue(new DOMException('Prompt dismissed', 'NotAllowedError'));

		const { result } = renderHook(() => useSpeechToText({ projectId: 'project-1' }));

		await act(async () => {
			await result.current.start();
		});

		await waitFor(() => {
			expect(result.current.microphonePermission).toBe('default');
			expect(result.current.isRecording).toBe(false);
		});

		expect(toastError).not.toHaveBeenCalled();

		await act(async () => {
			await result.current.start();
		});

		expect(getUserMediaMock).toHaveBeenCalledTimes(2);
	});

	it('does not mark microphone approval as pending until recording permission is actually requested', async () => {
		const { result } = renderHook(() => useSpeechToText({ projectId: 'project-1' }));

		await waitFor(() => {
			expect(result.current.microphonePermission).toBe('default');
		});

		expect(result.current.needsPermissionApproval).toBe(false);
	});

	it('marks microphone permission as denied only when the browser reports denied', async () => {
		permissionStatus.state = 'denied';
		getUserMediaMock.mockRejectedValue(new DOMException('Permission denied', 'NotAllowedError'));

		const { result } = renderHook(() => useSpeechToText({ projectId: 'project-1' }));

		await act(async () => {
			await result.current.start();
		});

		await waitFor(() => {
			expect(result.current.microphonePermission).toBe('denied');
		});

		expect(toastError).toHaveBeenCalledWith('Microphone permission denied');
	});

	it('updates microphone permission when the browser permission changes', async () => {
		const { result } = renderHook(() => useSpeechToText({ projectId: 'project-1' }));

		await waitFor(() => {
			expect(permissionStatus.addEventListener).toHaveBeenCalled();
		});

		permissionStatus.state = 'granted';
		await act(async () => {
			permissionChangeListener?.(new Event('change'));
		});

		await waitFor(() => {
			expect(result.current.microphonePermission).toBe('granted');
		});
	});
});
