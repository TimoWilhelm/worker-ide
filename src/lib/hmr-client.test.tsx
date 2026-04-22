import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import hmrClientSource from '@worker/lib/preview-scripts/hmr-client.js?raw';

const { default: previewRuntimeSource } = await import('@worker/lib/preview-scripts/preview-runtime.js?raw');

interface PreviewRuntimeApi {
	applyUpdate(update: {
		type: 'update';
		path: string;
		timestamp: number;
		targets: Array<{ id: string; kind: 'module' | 'style-link' }>;
	}): Promise<void>;
	registerModule(moduleId: string, importedModuleIds: string[]): void;
	createHotContext(moduleId: string): {
		accept(
			dependenciesOrCallback?: string | string[] | ((moduleNamespace: unknown) => void),
			callback?: (moduleNamespace: unknown) => void,
		): void;
	};
}

function isPreviewRuntimeApi(value: unknown): value is PreviewRuntimeApi {
	return (
		typeof value === 'object' &&
		value !== undefined &&
		value !== null &&
		'applyUpdate' in value &&
		'registerModule' in value &&
		'createHotContext' in value
	);
}

class FakeWebSocket {
	static readonly OPEN = 1;
	static instances: FakeWebSocket[] = [];

	readonly listeners = new Map<string, Array<(event: { data?: string }) => void>>();
	readonly sentMessages: string[] = [];
	readyState = FakeWebSocket.OPEN;

	constructor(_url: string) {
		FakeWebSocket.instances.push(this);
	}

	addEventListener(type: string, listener: (event: { data?: string }) => void): void {
		const listeners = this.listeners.get(type) ?? [];
		listeners.push(listener);
		this.listeners.set(type, listeners);
	}

	send(message: string): void {
		this.sentMessages.push(message);
	}

	dispatch(type: string, event: { data?: string } = {}): void {
		for (const listener of this.listeners.get(type) ?? []) {
			listener(event);
		}
	}

	static reset(): void {
		FakeWebSocket.instances = [];
	}
}

function flushPromises(): Promise<void> {
	return Promise.resolve().then(() => {});
}

function bootPreviewRuntime(): void {
	globalThis.eval(previewRuntimeSource);
}

function getPreviewRuntime(): PreviewRuntimeApi {
	const runtime = Reflect.get(globalThis, '__PREVIEW_RUNTIME__');
	if (!isPreviewRuntimeApi(runtime)) {
		throw new Error('Expected preview runtime to be available');
	}
	return runtime;
}

function bootHmrClient(): FakeWebSocket {
	Reflect.set(globalThis, '__PREVIEW_CONFIG', {
		wsUrl: 'ws://preview.test/__ws',
		ideOrigin: 'https://ide.test',
		projectId: 'project-1',
	});

	globalThis.eval(hmrClientSource);

	const socket = FakeWebSocket.instances.at(-1);
	if (socket === undefined) {
		throw new Error('Expected HMR client to open a WebSocket');
	}

	return socket;
}

describe('preview runtime and hmr transport', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		FakeWebSocket.reset();
		document.head.innerHTML = '';
		document.body.innerHTML = '';
		vi.stubGlobal('WebSocket', FakeWebSocket);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		vi.useRealTimers();
		Reflect.deleteProperty(globalThis, '__PREVIEW_CONFIG');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME__');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME_IMPORT__');
		Reflect.deleteProperty(globalThis, '__PREVIEW_RUNTIME_RELOAD__');
		document.head.innerHTML = '';
		document.body.innerHTML = '';
	});

	it('forwards websocket updates to the preview runtime', async () => {
		const applyUpdate = vi.fn(async () => {});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME__', { applyUpdate });

		const socket = bootHmrClient();
		const update = {
			type: 'update',
			path: '/src/style.css',
			timestamp: 123,
			targets: [{ id: '/src/style.css?mode=module', kind: 'module' }],
		};

		socket.dispatch('message', {
			data: JSON.stringify({
				type: 'update',
				version: 1,
				updates: [update],
			}),
		});

		await flushPromises();

		expect(applyUpdate).toHaveBeenCalledWith(update);
	});

	it('updates linked stylesheets using canonical preview ids', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const link = document.createElement('link');
		link.setAttribute('rel', 'stylesheet');
		link.setAttribute('href', '/src/style.css');
		link.dataset.previewId = '/src/style.css';
		document.head.append(link);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/style.css',
			timestamp: 123,
			targets: [{ id: '/src/style.css', kind: 'style-link' }],
		});

		expect(link.getAttribute('href')).toBe('/src/style.css?t=123');
	});

	it('reruns the nearest accepted boundary for dependency changes', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const importModule = vi.fn(async (_moduleId: string, importUrl: string) => ({ importUrl }));
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);
		Reflect.set(globalThis, '__RefreshRuntime', { performReactRefresh: vi.fn() });

		previewRuntime.registerModule('/src/util.ts', []);
		previewRuntime.registerModule('/src/app.tsx', ['/src/util.ts']);
		previewRuntime.createHotContext('/src/app.tsx').accept();

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/util.ts',
			timestamp: 456,
			targets: [{ id: '/src/util.ts', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/app.tsx', '/src/app.tsx?t=456');
	});

	it('runs dependency acceptance callbacks with the updated module namespace', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const importModule = vi.fn(async (moduleId: string) => ({ moduleId, next: true }));
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);

		previewRuntime.registerModule('/src/dep.ts', []);
		previewRuntime.registerModule('/src/entry.ts', ['/src/dep.ts']);

		const acceptCallback = vi.fn();
		previewRuntime.createHotContext('/src/entry.ts').accept('./dep.ts', acceptCallback);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/dep.ts',
			timestamp: 789,
			targets: [{ id: '/src/dep.ts', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/dep.ts', '/src/dep.ts?t=789');
		expect(acceptCallback).toHaveBeenCalledWith({ moduleId: '/src/dep.ts', next: true });
	});

	it('reloads when an updated module is not in the running graph', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();
		const reloadSpy = vi.fn();
		const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_RELOAD__', reloadSpy);

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/new-module.ts',
			timestamp: 101,
			targets: [{ id: '/src/new-module.ts', kind: 'module' }],
		});

		expect(debugSpy).toHaveBeenCalledWith('[preview-hmr] changed module not in running graph; reloading preview', '/src/new-module.ts');
		expect(reloadSpy).toHaveBeenCalledTimes(1);
	});

	it('preserves an existing self-accept callback when auto-accept runs afterwards', async () => {
		bootPreviewRuntime();
		const previewRuntime = getPreviewRuntime();

		const acceptCallback = vi.fn();
		const importModule = vi.fn(async () => {
			previewRuntime.registerModule('/src/app.tsx', []);
			const hot = previewRuntime.createHotContext('/src/app.tsx');
			hot.accept(acceptCallback);
			hot.accept();
			return { refreshed: true };
		});
		Reflect.set(globalThis, '__PREVIEW_RUNTIME_IMPORT__', importModule);

		previewRuntime.registerModule('/src/app.tsx', []);
		const hot = previewRuntime.createHotContext('/src/app.tsx');
		hot.accept(acceptCallback);
		hot.accept();

		await previewRuntime.applyUpdate({
			type: 'update',
			path: '/src/app.tsx',
			timestamp: 202,
			targets: [{ id: '/src/app.tsx', kind: 'module' }],
		});

		expect(importModule).toHaveBeenCalledWith('/src/app.tsx', '/src/app.tsx?t=202');
		expect(acceptCallback).toHaveBeenCalledWith({ refreshed: true });
	});
});
