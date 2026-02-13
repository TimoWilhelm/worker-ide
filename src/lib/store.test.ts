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
		pendingChanges: new Map(),
		sidebarVisible: true,
		terminalVisible: true,
		aiPanelVisible: false,
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
// Pending Changes slice
// =============================================================================

describe('Pending Changes slice', () => {
	const sampleChange = {
		path: '/src/main.ts',
		action: 'edit' as const,
		beforeContent: 'old content',
		afterContent: 'new content',
		snapshotId: undefined,
	};

	it('adds a pending change', () => {
		useStore.getState().addPendingChange(sampleChange);

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change).toBeDefined();
		expect(change?.status).toBe('pending');
		expect(change?.action).toBe('edit');
	});

	it('deduplicates by keeping first beforeContent', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({
			...sampleChange,
			beforeContent: 'intermediate content',
			afterContent: 'final content',
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.beforeContent).toBe('old content');
		expect(change?.afterContent).toBe('final content');
	});

	it('approves a change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().approveChange('/src/main.ts');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('approved');
	});

	it('rejects a change', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().rejectChange('/src/main.ts');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('rejected');
	});

	it('approves all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().approveAllChanges();

		for (const change of useStore.getState().pendingChanges.values()) {
			expect(change.status).toBe('approved');
		}
	});

	it('rejects all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().rejectAllChanges();

		for (const change of useStore.getState().pendingChanges.values()) {
			expect(change.status).toBe('rejected');
		}
	});

	it('does not change already-approved items when rejecting all', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().addPendingChange({ ...sampleChange, path: '/src/app.tsx' });
		useStore.getState().approveChange('/src/main.ts');
		useStore.getState().rejectAllChanges();

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.status).toBe('approved');
		expect(useStore.getState().pendingChanges.get('/src/app.tsx')?.status).toBe('rejected');
	});

	it('clears all pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().clearPendingChanges();

		expect(useStore.getState().pendingChanges.size).toBe(0);
	});

	it('associates snapshot with pending changes', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().associateSnapshotWithPending('snap-123');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.snapshotId).toBe('snap-123');
	});

	it('does not overwrite existing snapshotId when associating', () => {
		useStore.getState().addPendingChange({ ...sampleChange, snapshotId: 'snap-old' });
		useStore.getState().associateSnapshotWithPending('snap-new');

		expect(useStore.getState().pendingChanges.get('/src/main.ts')?.snapshotId).toBe('snap-old');
	});

	it('preserves snapshotId when re-adding a change for the same file', () => {
		useStore.getState().addPendingChange(sampleChange);
		useStore.getState().associateSnapshotWithPending('snap-123');
		useStore.getState().addPendingChange({
			...sampleChange,
			afterContent: 'final content',
			snapshotId: undefined,
		});

		const change = useStore.getState().pendingChanges.get('/src/main.ts');
		expect(change?.snapshotId).toBe('snap-123');
		expect(change?.beforeContent).toBe('old content');
		expect(change?.afterContent).toBe('final content');
	});
});

// =============================================================================
// Plan mode
// =============================================================================

describe('Plan mode', () => {
	it('defaults planMode to false', () => {
		expect(useStore.getState().planMode).toBe(false);
	});

	it('toggles planMode', () => {
		useStore.getState().togglePlanMode();
		expect(useStore.getState().planMode).toBe(true);
		useStore.getState().togglePlanMode();
		expect(useStore.getState().planMode).toBe(false);
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
});
