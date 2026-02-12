/**
 * Unit tests for the Zustand store.
 */

import { describe, expect, it, beforeEach } from 'vitest';

import { useStore } from './store';

// Reset store before each test
beforeEach(() => {
	useStore.setState({
		activeFile: undefined,
		openFiles: [],
		cursorPosition: undefined,
		unsavedChanges: new Map(),
		files: [],
		selectedFile: undefined,
		expandedDirs: new Set(),
		isLoading: false,
		history: [],
		isProcessing: false,
		statusMessage: undefined,
		sessionId: undefined,
		savedSessions: [],
		participants: [],
		localParticipantId: undefined,
		isConnected: false,
		snapshots: [],
		activeSnapshot: undefined,
		sidebarVisible: true,
		terminalVisible: true,
		aiPanelVisible: false,
		terminalHeight: 200,
		sidebarWidth: 240,
	});
});

// =============================================================================
// Editor slice
// =============================================================================

describe('Editor slice', () => {
	it('opens a file', () => {
		useStore.getState().openFile('/src/main.ts');

		const state = useStore.getState();
		expect(state.activeFile).toBe('/src/main.ts');
		expect(state.openFiles).toContain('/src/main.ts');
	});

	it('does not duplicate open files', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().openFile('/src/main.ts');

		expect(useStore.getState().openFiles).toHaveLength(1);
	});

	it('closes a file', () => {
		useStore.getState().openFile('/src/main.ts');
		useStore.getState().openFile('/src/app.tsx');
		useStore.getState().closeFile('/src/main.ts');

		const state = useStore.getState();
		expect(state.openFiles).not.toContain('/src/main.ts');
		expect(state.openFiles).toContain('/src/app.tsx');
	});

	it('sets active file to last open file when closing active', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');
		useStore.getState().closeFile('/src/b.ts');

		expect(useStore.getState().activeFile).toBe('/src/a.ts');
	});

	it('sets active file to undefined when closing last file', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().closeFile('/src/a.ts');

		expect(useStore.getState().activeFile).toBeUndefined();
	});

	it('sets cursor position', () => {
		useStore.getState().setCursorPosition({ line: 10, column: 5 });

		expect(useStore.getState().cursorPosition).toEqual({ line: 10, column: 5 });
	});

	it('marks file as changed', () => {
		useStore.getState().markFileChanged('/src/main.ts', true);

		expect(useStore.getState().unsavedChanges.get('/src/main.ts')).toBe(true);
	});

	it('closes all files', () => {
		useStore.getState().openFile('/src/a.ts');
		useStore.getState().openFile('/src/b.ts');
		useStore.getState().closeAllFiles();

		const state = useStore.getState();
		expect(state.openFiles).toHaveLength(0);
		expect(state.activeFile).toBeUndefined();
	});
});

// =============================================================================
// File Tree slice
// =============================================================================

describe('File Tree slice', () => {
	it('sets files', () => {
		const files = [
			{ path: '/src/main.ts', name: 'main.ts', isDirectory: false },
			{ path: '/src/app.tsx', name: 'app.tsx', isDirectory: false },
		];
		useStore.getState().setFiles(files);

		expect(useStore.getState().files).toHaveLength(2);
	});

	it('toggles directory expansion', () => {
		useStore.getState().toggleDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(true);

		useStore.getState().toggleDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(false);
	});

	it('expands a directory', () => {
		useStore.getState().expandDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(true);
	});

	it('collapses a directory', () => {
		useStore.getState().expandDirectory('/src');
		useStore.getState().collapseDirectory('/src');
		expect(useStore.getState().expandedDirs.has('/src')).toBe(false);
	});

	it('sets selected file', () => {
		useStore.getState().setSelectedFile('/src/main.ts');
		expect(useStore.getState().selectedFile).toBe('/src/main.ts');
	});
});

// =============================================================================
// AI slice
// =============================================================================

describe('AI slice', () => {
	it('adds a message to history', () => {
		useStore.getState().addMessage({
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
		});

		expect(useStore.getState().history).toHaveLength(1);
		expect(useStore.getState().history[0].role).toBe('user');
	});

	it('clears history', () => {
		useStore.getState().addMessage({
			role: 'user',
			content: [{ type: 'text', text: 'Hello' }],
		});
		useStore.getState().clearHistory();

		expect(useStore.getState().history).toHaveLength(0);
	});

	it('sets processing state', () => {
		useStore.getState().setProcessing(true);
		expect(useStore.getState().isProcessing).toBe(true);
	});

	it('sets status message', () => {
		useStore.getState().setStatusMessage('Thinking...');
		expect(useStore.getState().statusMessage).toBe('Thinking...');
	});
});

// =============================================================================
// Collaboration slice
// =============================================================================

describe('Collaboration slice', () => {
	it('adds a participant', () => {
		useStore.getState().addParticipant({
			id: 'user1',
			color: '#f97316',
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			file: null,
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			cursor: null,
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			selection: null,
		});

		expect(useStore.getState().participants).toHaveLength(1);
	});

	it('removes a participant', () => {
		useStore.getState().addParticipant({
			id: 'user1',
			color: '#f97316',
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			file: null,
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			cursor: null,
			// eslint-disable-next-line unicorn/no-null -- Participant type uses null
			selection: null,
		});
		useStore.getState().removeParticipant('user1');

		expect(useStore.getState().participants).toHaveLength(0);
	});

	it('sets connected state', () => {
		useStore.getState().setConnected(true);
		expect(useStore.getState().isConnected).toBe(true);
	});
});

// =============================================================================
// UI slice
// =============================================================================

describe('UI slice', () => {
	it('toggles sidebar', () => {
		expect(useStore.getState().sidebarVisible).toBe(true);
		useStore.getState().toggleSidebar();
		expect(useStore.getState().sidebarVisible).toBe(false);
		useStore.getState().toggleSidebar();
		expect(useStore.getState().sidebarVisible).toBe(true);
	});

	it('toggles terminal', () => {
		expect(useStore.getState().terminalVisible).toBe(true);
		useStore.getState().toggleTerminal();
		expect(useStore.getState().terminalVisible).toBe(false);
	});

	it('toggles AI panel', () => {
		expect(useStore.getState().aiPanelVisible).toBe(false);
		useStore.getState().toggleAIPanel();
		expect(useStore.getState().aiPanelVisible).toBe(true);
	});

	it('sets terminal height within bounds', () => {
		useStore.getState().setTerminalHeight(300);
		expect(useStore.getState().terminalHeight).toBe(300);
	});

	it('clamps terminal height to minimum', () => {
		useStore.getState().setTerminalHeight(50);
		expect(useStore.getState().terminalHeight).toBe(100);
	});

	it('clamps terminal height to maximum', () => {
		useStore.getState().setTerminalHeight(1000);
		expect(useStore.getState().terminalHeight).toBe(500);
	});

	it('sets sidebar width', () => {
		useStore.getState().setSidebarWidth(300);
		expect(useStore.getState().sidebarWidth).toBe(300);
	});
});
