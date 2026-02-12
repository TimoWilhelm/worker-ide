/**
 * Global Application Store
 *
 * Zustand store for managing global application state.
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import type { FileInfo, AgentMessage, Participant, SnapshotSummary } from '@shared/types';

// =============================================================================
// Editor State
// =============================================================================

interface EditorState {
	/** Currently open file path */
	activeFile: string | undefined;
	/** List of open files (tabs) */
	openFiles: string[];
	/** Cursor position in active file */
	cursorPosition: { line: number; column: number } | undefined;
	/** Unsaved changes per file */
	unsavedChanges: Map<string, boolean>;
}

interface EditorActions {
	setActiveFile: (path: string | undefined) => void;
	openFile: (path: string) => void;
	closeFile: (path: string) => void;
	setCursorPosition: (position: { line: number; column: number } | undefined) => void;
	markFileChanged: (path: string, changed: boolean) => void;
	closeAllFiles: () => void;
}

// =============================================================================
// File Tree State
// =============================================================================

interface FileTreeState {
	/** List of all files in the project */
	files: FileInfo[];
	/** Currently selected file in tree */
	selectedFile: string | undefined;
	/** Expanded directories */
	expandedDirs: Set<string>;
	/** Loading state */
	isLoading: boolean;
}

interface FileTreeActions {
	setFiles: (files: FileInfo[]) => void;
	setSelectedFile: (path: string | undefined) => void;
	toggleDirectory: (path: string) => void;
	expandDirectory: (path: string) => void;
	collapseDirectory: (path: string) => void;
	setLoading: (loading: boolean) => void;
}

// =============================================================================
// AI Assistant State
// =============================================================================

interface AIState {
	/** Current conversation history */
	history: AgentMessage[];
	/** Whether AI is currently processing */
	isProcessing: boolean;
	/** Current status message */
	statusMessage: string | undefined;
	/** Session ID for persistence */
	sessionId: string | undefined;
	/** List of saved sessions */
	savedSessions: Array<{ id: string; label: string; createdAt: number }>;
}

interface AIActions {
	addMessage: (message: AgentMessage) => void;
	clearHistory: () => void;
	setProcessing: (processing: boolean) => void;
	setStatusMessage: (message: string | undefined) => void;
	setSessionId: (id: string | undefined) => void;
	setSavedSessions: (sessions: Array<{ id: string; label: string; createdAt: number }>) => void;
	loadSession: (history: AgentMessage[], sessionId: string) => void;
}

// =============================================================================
// Collaboration State
// =============================================================================

interface CollaborationState {
	/** Current participants in the session */
	participants: Participant[];
	/** Local participant ID */
	localParticipantId: string | undefined;
	/** Connection status */
	isConnected: boolean;
}

interface CollaborationActions {
	setParticipants: (participants: Participant[]) => void;
	addParticipant: (participant: Participant) => void;
	removeParticipant: (id: string) => void;
	updateParticipant: (id: string, updates: Partial<Participant>) => void;
	setLocalParticipantId: (id: string) => void;
	setConnected: (connected: boolean) => void;
}

// =============================================================================
// Snapshot State
// =============================================================================

interface SnapshotState {
	/** List of available snapshots */
	snapshots: SnapshotSummary[];
	/** Currently viewing snapshot */
	activeSnapshot: string | undefined;
}

interface SnapshotActions {
	setSnapshots: (snapshots: SnapshotSummary[]) => void;
	addSnapshot: (snapshot: SnapshotSummary) => void;
	setActiveSnapshot: (id: string | undefined) => void;
}

// =============================================================================
// UI State
// =============================================================================

interface UIState {
	/** Whether sidebar is visible */
	sidebarVisible: boolean;
	/** Whether terminal is visible */
	terminalVisible: boolean;
	/** Whether AI panel is visible */
	aiPanelVisible: boolean;
	/** Terminal height in pixels */
	terminalHeight: number;
	/** Sidebar width in pixels */
	sidebarWidth: number;
}

interface UIActions {
	toggleSidebar: () => void;
	toggleTerminal: () => void;
	toggleAIPanel: () => void;
	setTerminalHeight: (height: number) => void;
	setSidebarWidth: (width: number) => void;
}

// =============================================================================
// Combined Store
// =============================================================================

type StoreState = EditorState &
	FileTreeState &
	AIState &
	CollaborationState &
	SnapshotState &
	UIState &
	EditorActions &
	FileTreeActions &
	AIActions &
	CollaborationActions &
	SnapshotActions &
	UIActions;

/**
 * Rehydrate expandedDirs from persisted array back to Set.
 */
function rehydrateExpandedDirectories(state: StoreState | undefined): void {
	if (!state) return;
	// The persisted value is serialized as a string array
	const { expandedDirs } = state;
	if (Array.isArray(expandedDirs)) {
		state.expandedDirs = new Set(expandedDirs);
	}
}

export const useStore = create<StoreState>()(
	devtools(
		persist(
			(set) => ({
				// =============================================================================
				// Editor State & Actions
				// =============================================================================
				activeFile: undefined,
				openFiles: [],
				cursorPosition: undefined,
				unsavedChanges: new Map(),

				setActiveFile: (path) => set({ activeFile: path }),

				openFile: (path) =>
					set((state) => ({
						openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
						activeFile: path,
					})),

				closeFile: (path) =>
					set((state) => {
						const newOpenFiles = state.openFiles.filter((f) => f !== path);
						const newUnsavedChanges = new Map(state.unsavedChanges);
						newUnsavedChanges.delete(path);
						return {
							openFiles: newOpenFiles,
							activeFile: state.activeFile === path ? newOpenFiles.at(-1) : state.activeFile,
							unsavedChanges: newUnsavedChanges,
						};
					}),

				setCursorPosition: (position) => set({ cursorPosition: position }),

				markFileChanged: (path, changed) =>
					set((state) => {
						const newUnsavedChanges = new Map(state.unsavedChanges);
						if (changed) {
							newUnsavedChanges.set(path, true);
						} else {
							newUnsavedChanges.delete(path);
						}
						return { unsavedChanges: newUnsavedChanges };
					}),

				closeAllFiles: () =>
					set({
						openFiles: [],
						activeFile: undefined,
						unsavedChanges: new Map(),
					}),

				// =============================================================================
				// File Tree State & Actions
				// =============================================================================
				files: [],
				selectedFile: undefined,
				expandedDirs: new Set(['/src', '/worker']),
				isLoading: true,

				setFiles: (files) => set({ files, isLoading: false }),

				setSelectedFile: (path) => set({ selectedFile: path }),

				toggleDirectory: (path) =>
					set((state) => {
						const newExpanded = new Set(state.expandedDirs);
						if (newExpanded.has(path)) {
							newExpanded.delete(path);
						} else {
							newExpanded.add(path);
						}
						return { expandedDirs: newExpanded };
					}),

				expandDirectory: (path) =>
					set((state) => ({
						expandedDirs: new Set([...state.expandedDirs, path]),
					})),

				collapseDirectory: (path) =>
					set((state) => {
						const newExpanded = new Set(state.expandedDirs);
						newExpanded.delete(path);
						return { expandedDirs: newExpanded };
					}),

				setLoading: (loading) => set({ isLoading: loading }),

				// =============================================================================
				// AI State & Actions
				// =============================================================================
				history: [],
				isProcessing: false,
				statusMessage: undefined,
				sessionId: undefined,
				savedSessions: [],

				addMessage: (message) =>
					set((state) => ({
						history: [...state.history, message],
					})),

				clearHistory: () => set({ history: [], sessionId: undefined }),

				setProcessing: (processing) => set({ isProcessing: processing }),

				setStatusMessage: (message) => set({ statusMessage: message }),

				setSessionId: (id) => set({ sessionId: id }),

				setSavedSessions: (sessions) => set({ savedSessions: sessions }),

				loadSession: (history, sessionId) => set({ history, sessionId }),

				// =============================================================================
				// Collaboration State & Actions
				// =============================================================================
				participants: [],
				localParticipantId: undefined,
				isConnected: false,

				setParticipants: (participants) => set({ participants }),

				addParticipant: (participant) =>
					set((state) => ({
						participants: [...state.participants, participant],
					})),

				removeParticipant: (id) =>
					set((state) => ({
						participants: state.participants.filter((p) => p.id !== id),
					})),

				updateParticipant: (id, updates) =>
					set((state) => ({
						participants: state.participants.map((p) => (p.id === id ? { ...p, ...updates } : p)),
					})),

				setLocalParticipantId: (id) => set({ localParticipantId: id }),

				setConnected: (connected) => set({ isConnected: connected }),

				// =============================================================================
				// Snapshot State & Actions
				// =============================================================================
				snapshots: [],
				activeSnapshot: undefined,

				setSnapshots: (snapshots) => set({ snapshots }),

				addSnapshot: (snapshot) =>
					set((state) => ({
						snapshots: [snapshot, ...state.snapshots].slice(0, 10),
					})),

				setActiveSnapshot: (id) => set({ activeSnapshot: id }),

				// =============================================================================
				// UI State & Actions
				// =============================================================================
				sidebarVisible: true,
				terminalVisible: true,
				aiPanelVisible: false,
				terminalHeight: 200,
				sidebarWidth: 220,

				toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

				toggleTerminal: () => set((state) => ({ terminalVisible: !state.terminalVisible })),

				toggleAIPanel: () => set((state) => ({ aiPanelVisible: !state.aiPanelVisible })),

				setTerminalHeight: (height) => set({ terminalHeight: Math.max(100, Math.min(500, height)) }),

				setSidebarWidth: (width) => set({ sidebarWidth: Math.max(150, Math.min(400, width)) }),
			}),
			{
				name: 'worker-ide-store',
				// Only persist UI preferences
				partialize: (state) => ({
					sidebarVisible: state.sidebarVisible,
					terminalVisible: state.terminalVisible,
					aiPanelVisible: state.aiPanelVisible,
					terminalHeight: state.terminalHeight,
					sidebarWidth: state.sidebarWidth,
					expandedDirs: [...state.expandedDirs],
				}),
				// Rehydrate expandedDirs as Set
				onRehydrateStorage: () => rehydrateExpandedDirectories,
			},
		),
		{ name: 'WorkerIDE' },
	),
);

// =============================================================================
// Selectors (for optimized re-renders)
// =============================================================================

export const selectActiveFile = (state: StoreState) => state.activeFile;
export const selectOpenFiles = (state: StoreState) => state.openFiles;
export const selectFiles = (state: StoreState) => state.files;
export const selectIsProcessing = (state: StoreState) => state.isProcessing;
export const selectParticipants = (state: StoreState) => state.participants;
export const selectSnapshots = (state: StoreState) => state.snapshots;
