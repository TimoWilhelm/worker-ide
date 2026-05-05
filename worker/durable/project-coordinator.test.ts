import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import { parseServerMessage, serializeMessage } from '@shared/ws-messages';

import type { ProjectCoordinatorV2 } from './project-coordinator';
import type { ServerMessage } from '@shared/ws-messages';

/**
 * Get a fresh ProjectCoordinatorV2 stub for testing.
 * Each call with a different name gets an isolated DO instance.
 */
function getCoordinatorStub(name: string): DurableObjectStub<ProjectCoordinatorV2> {
	const namespace = env.ProjectCoordinatorV2 as DurableObjectNamespace<ProjectCoordinatorV2>;
	return namespace.getByName(name);
}

async function connectIdeSocket(
	stub: DurableObjectStub<ProjectCoordinatorV2>,
	name: string,
	collaborationVisible: boolean,
): Promise<WebSocket> {
	const response = await stub.fetch(
		new Request(`https://example.test/ws?name=${name}`, {
			headers: {
				Upgrade: 'websocket',
				'x-project-id': name,
				'x-worker-ide-client-kind': 'ide',
				'x-worker-ide-collaboration-visible': collaborationVisible ? 'true' : 'false',
			},
		}),
	);
	const socket = response.webSocket;
	if (!socket) {
		throw new Error('Expected WebSocket upgrade response');
	}
	socket.accept();
	return socket;
}

function readNextMessage(socket: WebSocket, timeoutMs = 1000): Promise<ServerMessage> {
	return new Promise((resolve, reject) => {
		const timeout = setTimeout(() => {
			socket.removeEventListener('message', handleMessage);
			reject(new Error(`Timed out waiting for WebSocket message after ${timeoutMs}ms`));
		}, timeoutMs);

		function handleMessage(event: MessageEvent) {
			clearTimeout(timeout);
			socket.removeEventListener('message', handleMessage);
			if (typeof event.data !== 'string') {
				reject(new Error('Expected string WebSocket message payload'));
				return;
			}
			const parsed = parseServerMessage(event.data);
			if (!parsed.success) {
				reject(new Error(parsed.error));
				return;
			}
			resolve(parsed.data);
		}

		socket.addEventListener('message', handleMessage);
	});
}

async function expectNoMessage(socket: WebSocket, timeoutMs = 75): Promise<void> {
	await expect(
		new Promise<ServerMessage>((resolve, reject) => {
			const timeout = setTimeout(() => {
				socket.removeEventListener('message', handleMessage);
				resolve({ type: 'pong' });
			}, timeoutMs);

			function handleMessage(event: MessageEvent) {
				clearTimeout(timeout);
				socket.removeEventListener('message', handleMessage);
				if (typeof event.data !== 'string') {
					reject(new Error('Expected string WebSocket message payload'));
					return;
				}
				const parsed = parseServerMessage(event.data);
				if (!parsed.success) {
					reject(new Error(parsed.error));
					return;
				}
				reject(new Error(`Unexpected WebSocket message: ${parsed.data.type}`));
			}

			socket.addEventListener('message', handleMessage);
		}),
	).resolves.toEqual({ type: 'pong' });
}

function sendClientMessage(socket: WebSocket, message: string): void {
	socket.send(message);
}

function closeSocket(socket: WebSocket): void {
	try {
		socket.close(1000, 'test complete');
	} catch {
		// ignore
	}
}

describe('getOutputLogs', () => {
	it('returns empty string initially', async () => {
		const stub = getCoordinatorStub('test-output-logs-empty');
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});

describe('sendMessage', () => {
	it('does not throw when no clients are connected', async () => {
		const stub = getCoordinatorStub('test-send-no-clients');
		await expect(
			stub.sendMessage({
				type: 'server-error',
				error: { id: 'e1', type: 'runtime', message: 'test error', timestamp: Date.now() },
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for non-error messages', async () => {
		const stub = getCoordinatorStub('test-send-non-error');
		await expect(
			stub.sendMessage({
				type: 'git-status-changed',
			}),
		).resolves.toBeUndefined();
	});
});

describe('triggerUpdate', () => {
	it('does not throw when no clients are connected', async () => {
		const stub = getCoordinatorStub('test-trigger-no-clients');
		await expect(
			stub.triggerUpdate({
				type: 'update',
				path: '/test.js',
				timestamp: Date.now(),
				targets: [{ id: '/test.js', kind: 'module' }],
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for full-reload updates', async () => {
		const stub = getCoordinatorStub('test-trigger-full-reload');
		await expect(
			stub.triggerUpdate({
				type: 'full-reload',
				path: '*',
				timestamp: Date.now(),
				targets: [],
			}),
		).resolves.toBeUndefined();
	});

	it('does not throw for CSS updates', async () => {
		const stub = getCoordinatorStub('test-trigger-css');
		await expect(
			stub.triggerUpdate({
				type: 'update',
				path: '/style.css',
				timestamp: Date.now(),
				targets: [
					{ id: '/style.css', kind: 'style-link' },
					{ id: '/style.css?mode=module', kind: 'module' },
				],
			}),
		).resolves.toBeUndefined();
	});
});

describe('output logs persistence', () => {
	it('getOutputLogs returns empty string when only non-log messages sent', async () => {
		const stub = getCoordinatorStub('test-output-no-logs');

		// Send a server-error (this goes to lastServerError, not outputLogs)
		await stub.sendMessage({
			type: 'server-error',
			error: { id: 'e2', type: 'bundle', message: 'Build failed', timestamp: 1234 },
		});

		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});

describe('external change buffering', () => {
	it('deduplicates repeated file edits by path and keeps the latest timestamp', async () => {
		const stub = getCoordinatorStub('test-external-file-edits');

		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/index.ts', timestamp: 10 });
		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/index.ts', timestamp: 20 });
		await stub.recordExternalChange({ kind: 'file-edit', path: '/src/other.ts', timestamp: 15 });

		const changes = await stub.getRecentExternalChanges();
		expect(changes).toEqual([
			{ kind: 'file-edit', path: '/src/other.ts', timestamp: 15 },
			{ kind: 'file-edit', path: '/src/index.ts', timestamp: 20 },
		]);

		expect(await stub.getRecentExternalChanges()).toEqual([]);
	});

	it('merges Wrangler settings updates into one semantic change entry', async () => {
		const stub = getCoordinatorStub('test-external-wrangler-settings');

		await stub.recordExternalChange({
			kind: 'wrangler-settings',
			path: '/wrangler.jsonc',
			timestamp: 30,
			domains: ['asset-settings'],
			assetSettings: {
				not_found_handling: 'single-page-application',
				html_handling: 'drop-trailing-slash',
			},
		});
		await stub.recordExternalChange({
			kind: 'wrangler-settings',
			path: '/wrangler.jsonc',
			timestamp: 40,
			domains: ['bindings-config'],
			bindingsConfig: { storage: true },
		});

		const changes = await stub.getRecentExternalChanges();
		expect(changes).toEqual([
			{
				kind: 'wrangler-settings',
				path: '/wrangler.jsonc',
				timestamp: 40,
				domains: ['asset-settings', 'bindings-config'],
				assetSettings: {
					not_found_handling: 'single-page-application',
					html_handling: 'drop-trailing-slash',
				},
				bindingsConfig: { storage: true },
			},
		]);
	});
});

describe('instance consistency', () => {
	it('multiple RPC calls on the same stub work correctly', async () => {
		const stub = getCoordinatorStub('test-instance-consistency');

		// Multiple sendMessage calls should not interfere with each other
		await stub.sendMessage({ type: 'git-status-changed' });
		await stub.sendMessage({ type: 'git-status-changed' });

		// getOutputLogs should still return empty (unrelated to sendMessage)
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});

	it('triggerUpdate and sendMessage work on the same instance', async () => {
		const stub = getCoordinatorStub('test-mixed-rpc');

		await stub.triggerUpdate({ type: 'update', path: '/a.js', timestamp: 1, targets: [{ id: '/a.js', kind: 'module' }] });
		await stub.sendMessage({ type: 'git-status-changed' });
		await stub.triggerUpdate({ type: 'update', path: '/b.js', timestamp: 2, targets: [{ id: '/b.js', kind: 'module' }] });

		// Should not throw or corrupt state
		const logs = await stub.getOutputLogs();
		expect(logs).toBe('');
	});
});

describe('collaboration visibility', () => {
	it('hides excluded sockets from participant state and presence broadcasts in both directions', async () => {
		const stub = getCoordinatorStub('test-hidden-collaboration-presence');
		const visibleSocket = await connectIdeSocket(stub, 'visible-user', true);
		const hiddenSocket = await connectIdeSocket(stub, 'hidden-user', false);
		const secondVisibleSocket = await connectIdeSocket(stub, 'visible-user-2', true);

		try {
			sendClientMessage(visibleSocket, serializeMessage({ type: 'collab-join' }));
			const visibleState = await readNextMessage(visibleSocket);
			expect(visibleState.type).toBe('collab-state');
			if (visibleState.type === 'collab-state') {
				expect(visibleState.participants).toEqual([]);
			}

			sendClientMessage(hiddenSocket, serializeMessage({ type: 'collab-join' }));
			const hiddenState = await readNextMessage(hiddenSocket);
			expect(hiddenState.type).toBe('collab-state');
			if (hiddenState.type === 'collab-state') {
				expect(hiddenState.participants).toEqual([]);
			}
			await expectNoMessage(visibleSocket);

			sendClientMessage(secondVisibleSocket, serializeMessage({ type: 'collab-join' }));
			const secondVisibleState = await readNextMessage(secondVisibleSocket);
			expect(secondVisibleState.type).toBe('collab-state');
			if (secondVisibleState.type === 'collab-state') {
				expect(secondVisibleState.participants).toHaveLength(1);
				if (visibleState.type === 'collab-state') {
					expect(secondVisibleState.participants[0]?.id).toBe(visibleState.selfId);
				}
			}

			const joinedMessage = await readNextMessage(visibleSocket);
			expect(joinedMessage.type).toBe('participant-joined');
			if (joinedMessage.type === 'participant-joined' && secondVisibleState.type === 'collab-state') {
				expect(joinedMessage.participant.id).toBe(secondVisibleState.selfId);
			}
			await expectNoMessage(hiddenSocket);

			sendClientMessage(
				visibleSocket,
				serializeMessage({
					type: 'cursor-update',
					file: '/src/app.ts',
					cursor: { line: 1, ch: 2 },
					selection: { anchor: { line: 1, ch: 2 }, head: { line: 1, ch: 4 } },
				}),
			);
			const visibleCursorUpdate = await readNextMessage(secondVisibleSocket);
			expect(visibleCursorUpdate.type).toBe('cursor-updated');
			await expectNoMessage(hiddenSocket);

			sendClientMessage(
				hiddenSocket,
				serializeMessage({
					type: 'cursor-update',
					file: '/src/hidden.ts',
					cursor: { line: 4, ch: 1 },
					selection: { anchor: { line: 4, ch: 1 }, head: { line: 4, ch: 3 } },
				}),
			);
			await expectNoMessage(visibleSocket);
			await expectNoMessage(secondVisibleSocket);

			closeSocket(secondVisibleSocket);
			const leftMessage = await readNextMessage(visibleSocket);
			expect(leftMessage.type).toBe('participant-left');
			await expectNoMessage(hiddenSocket);

			closeSocket(hiddenSocket);
			await expectNoMessage(visibleSocket);
		} finally {
			closeSocket(visibleSocket);
			closeSocket(hiddenSocket);
			closeSocket(secondVisibleSocket);
		}
	});

	it('still delivers file edit messages to hidden sockets', async () => {
		const stub = getCoordinatorStub('test-hidden-collaboration-file-edits');
		const visibleSocket = await connectIdeSocket(stub, 'visible-file-user', true);
		const hiddenSocket = await connectIdeSocket(stub, 'hidden-file-user', false);

		try {
			sendClientMessage(visibleSocket, serializeMessage({ type: 'collab-join' }));
			await readNextMessage(visibleSocket);

			sendClientMessage(hiddenSocket, serializeMessage({ type: 'collab-join' }));
			await readNextMessage(hiddenSocket);
			await expectNoMessage(visibleSocket);

			sendClientMessage(visibleSocket, serializeMessage({ type: 'file-edit', path: '/src/demo.ts', content: 'export const value = 1;' }));
			const editForHiddenSocket = await readNextMessage(hiddenSocket);
			expect(editForHiddenSocket.type).toBe('file-edited');
			if (editForHiddenSocket.type === 'file-edited') {
				expect(editForHiddenSocket.path).toBe('/src/demo.ts');
				expect(editForHiddenSocket.content).toBe('export const value = 1;');
			}

			sendClientMessage(hiddenSocket, serializeMessage({ type: 'file-edit', path: '/src/demo.ts', content: 'export const value = 2;' }));
			const editForVisibleSocket = await readNextMessage(visibleSocket);
			expect(editForVisibleSocket.type).toBe('file-edited');
			if (editForVisibleSocket.type === 'file-edited') {
				expect(editForVisibleSocket.path).toBe('/src/demo.ts');
				expect(editForVisibleSocket.content).toBe('export const value = 2;');
			}
		} finally {
			closeSocket(visibleSocket);
			closeSocket(hiddenSocket);
		}
	});
});
