/**
 * Global Application Store
 *
 * Zustand store for managing global application state.
 */

import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import type {
	AgentMode,
	FileInfo,
	AgentMessage,
	GitBranchInfo,
	GitStatusEntry,
	Participant,
	PendingFileChange,
	SnapshotSummary,
} from '@shared/types';

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
	/** Pending navigation target — set externally (e.g. output link, error overlay) and consumed by the editor */
	pendingGoTo: { line: number; column: number } | undefined;
	/** Unsaved changes per file */
	unsavedChanges: Map<string, boolean>;
}

interface EditorActions {
	setActiveFile: (path: string | undefined) => void;
	openFile: (path: string) => void;
	closeFile: (path: string) => void;
	setCursorPosition: (position: { line: number; column: number } | undefined) => void;
	/** Navigate the editor to a specific file and position (consumed once by the editor) */
	goToFilePosition: (path: string, position: { line: number; column: number }) => void;
	/** Clear pending navigation after the editor has consumed it */
	clearPendingGoTo: () => void;
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

interface AIError {
	message: string;
	code?: string;
}

interface AIState {
	/** Current conversation history */
	history: AgentMessage[];
	/** Whether AI is currently processing */
	isProcessing: boolean;
	/** Current status message */
	statusMessage: string | undefined;
	/** Current error state */
	aiError: AIError | undefined;
	/** Session ID for persistence */
	sessionId: string | undefined;
	/** List of saved sessions */
	savedSessions: Array<{ id: string; label: string; createdAt: number }>;
	/** Maps message index to snapshot ID (for revert buttons on user messages) */
	messageSnapshots: Map<number, string>;
	/** Current agent operating mode */
	agentMode: AgentMode;
}

interface AIActions {
	addMessage: (message: AgentMessage) => void;
	clearHistory: () => void;
	setProcessing: (processing: boolean) => void;
	setStatusMessage: (message: string | undefined) => void;
	setAiError: (error: AIError | undefined) => void;
	setSessionId: (id: string | undefined) => void;
	setSavedSessions: (sessions: Array<{ id: string; label: string; createdAt: number }>) => void;
	loadSession: (history: AgentMessage[], sessionId: string, messageSnapshots?: Map<number, string>) => void;
	setMessageSnapshot: (messageIndex: number, snapshotId: string) => void;
	removeMessagesAfter: (index: number) => void;
	removeMessagesFrom: (index: number) => void;
	setAgentMode: (mode: AgentMode) => void;
}

// =============================================================================
// Collaboration State
// =============================================================================

interface CollaborationState {
	/** Current participants in the session */
	participants: Participant[];
	/** Local participant ID */
	localParticipantId: string | undefined;
	/** Local participant color (assigned by the server) */
	localParticipantColor: string | undefined;
	/** Connection status */
	isConnected: boolean;
}

interface CollaborationActions {
	setParticipants: (participants: Participant[]) => void;
	addParticipant: (participant: Participant) => void;
	removeParticipant: (id: string) => void;
	updateParticipant: (id: string, updates: Partial<Participant>) => void;
	setLocalParticipantId: (id: string) => void;
	setLocalParticipantColor: (color: string) => void;
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
// Pending AI Changes State
// =============================================================================

interface PendingChangesState {
	/** AI file changes awaiting user review, keyed by file path */
	pendingChanges: Map<string, PendingFileChange>;
}

interface PendingChangesActions {
	addPendingChange: (change: Omit<PendingFileChange, 'status'>) => void;
	approveChange: (path: string) => void;
	rejectChange: (path: string) => void;
	approveAllChanges: () => void;
	rejectAllChanges: () => void;
	clearPendingChanges: () => void;
	associateSnapshotWithPending: (snapshotId: string) => void;
}

// =============================================================================
// UI State
// =============================================================================

type ColorScheme = 'light' | 'dark' | 'system';

export type MobilePanel = 'editor' | 'preview' | 'git' | 'agent';

export type SidebarView = 'explorer' | 'git';

interface UIState {
	/** Whether sidebar is visible */
	sidebarVisible: boolean;
	/** Whether utility panel is visible */
	utilityPanelVisible: boolean;
	/** Whether AI panel is visible */
	aiPanelVisible: boolean;
	/** Whether DevTools panel is visible below the preview */
	devtoolsVisible: boolean;
	/** Color scheme preference */
	colorScheme: ColorScheme;
	/** Active panel on mobile layout */
	activeMobilePanel: MobilePanel;
	/** Whether the mobile file tree drawer is open */
	mobileFileTreeOpen: boolean;
	/** Which sidebar view is active (activity bar selection) */
	activeSidebarView: SidebarView;
}

interface UIActions {
	toggleSidebar: () => void;
	toggleUtilityPanel: () => void;
	toggleAIPanel: () => void;
	toggleDevtools: () => void;
	setColorScheme: (scheme: ColorScheme) => void;
	setActiveMobilePanel: (panel: MobilePanel) => void;
	toggleMobileFileTree: () => void;
	setActiveSidebarView: (view: SidebarView) => void;
}

// =============================================================================
// Git State
// =============================================================================

interface GitState {
	/** Current git status entries for all tracked/untracked files */
	gitStatus: GitStatusEntry[];
	/** Available branches */
	gitBranches: GitBranchInfo[];
	/** Whether git status is currently being fetched */
	gitStatusLoading: boolean;
	/** Whether git has been initialized in this project */
	gitInitialized: boolean;
}

interface GitActions {
	setGitStatus: (entries: GitStatusEntry[]) => void;
	setGitBranches: (branches: GitBranchInfo[]) => void;
	setGitStatusLoading: (loading: boolean) => void;
	setGitInitialized: (initialized: boolean) => void;
}

// =============================================================================
// Combined Store
// =============================================================================

type StoreState = EditorState &
	FileTreeState &
	AIState &
	CollaborationState &
	SnapshotState &
	PendingChangesState &
	UIState &
	GitState &
	EditorActions &
	FileTreeActions &
	AIActions &
	CollaborationActions &
	SnapshotActions &
	PendingChangesActions &
	UIActions &
	GitActions;

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
				pendingGoTo: undefined,
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

				goToFilePosition: (path, position) =>
					set((state) => ({
						openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
						activeFile: path,
						pendingGoTo: position,
					})),

				clearPendingGoTo: () => set({ pendingGoTo: undefined }),

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
				aiError: undefined,
				sessionId: undefined,
				savedSessions: [],
				messageSnapshots: new Map(),
				agentMode: 'code',

				addMessage: (message) =>
					set((state) => ({
						history: [...state.history, message],
					})),

				clearHistory: () => set({ history: [], sessionId: undefined, messageSnapshots: new Map(), aiError: undefined }),

				setProcessing: (processing) => set({ isProcessing: processing }),

				setStatusMessage: (message) => set({ statusMessage: message }),

				setAiError: (error) => set({ aiError: error }),

				setSessionId: (id) => set({ sessionId: id }),

				setSavedSessions: (sessions) => set({ savedSessions: sessions }),

				loadSession: (history, sessionId, messageSnapshots) =>
					set({ history, sessionId, messageSnapshots: messageSnapshots ?? new Map(), aiError: undefined }),

				setMessageSnapshot: (messageIndex, snapshotId) =>
					set((state) => {
						const newMap = new Map(state.messageSnapshots);
						newMap.set(messageIndex, snapshotId);
						return { messageSnapshots: newMap };
					}),

				removeMessagesAfter: (index) =>
					set((state) => ({
						history: state.history.slice(0, index + 1),
					})),
				setAgentMode: (mode) => set({ agentMode: mode }),

				removeMessagesFrom: (index) =>
					set((state) => {
						const newSnapshots = new Map<number, string>();
						for (const [key, value] of state.messageSnapshots) {
							if (key < index) {
								newSnapshots.set(key, value);
							}
						}
						return {
							history: state.history.slice(0, index),
							messageSnapshots: newSnapshots,
						};
					}),

				// =============================================================================
				// Collaboration State & Actions
				// =============================================================================
				participants: [],
				localParticipantId: undefined,
				localParticipantColor: undefined,
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

				setLocalParticipantColor: (color) => set({ localParticipantColor: color }),

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
				// Pending AI Changes State & Actions
				// =============================================================================
				pendingChanges: new Map(),

				addPendingChange: (change) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const existing = newMap.get(change.path);

						if (!existing) {
							// Move actions always show (no content diff needed)
							// For other actions, skip if content is identical (no actual change)
							if (change.action !== 'move' && change.beforeContent !== undefined && change.beforeContent === change.afterContent) {
								return { pendingChanges: newMap };
							}
							newMap.set(change.path, { ...change, status: 'pending' });
							return { pendingChanges: newMap };
						}

						// Keep the first beforeContent and existing snapshotId for dedup
						const beforeContent = existing.beforeContent;
						const snapshotId = existing.snapshotId ?? change.snapshotId;

						// Resolve combined action based on original + new action
						const originalAction = existing.action;
						const newAction = change.action;

						// create → delete = net no-op (file never existed in snapshot)
						if (originalAction === 'create' && newAction === 'delete') {
							newMap.delete(change.path);
							return { pendingChanges: newMap };
						}

						// create → edit = still a create (with updated content)
						if (originalAction === 'create' && newAction === 'edit') {
							// If the final content matches the original beforeContent, it's a no-op
							if (beforeContent !== undefined && beforeContent === change.afterContent) {
								newMap.delete(change.path);
								return { pendingChanges: newMap };
							}
							newMap.set(change.path, {
								...change,
								action: 'create',
								beforeContent,
								snapshotId,
								status: 'pending',
							});
							return { pendingChanges: newMap };
						}

						// delete → create = effectively an edit (file was replaced)
						if (originalAction === 'delete' && newAction === 'create') {
							// If recreated content matches original, it's a no-op
							if (beforeContent !== undefined && beforeContent === change.afterContent) {
								newMap.delete(change.path);
								return { pendingChanges: newMap };
							}
							newMap.set(change.path, {
								...change,
								action: 'edit',
								beforeContent,
								snapshotId,
								status: 'pending',
							});
							return { pendingChanges: newMap };
						}

						// All other cases: keep original beforeContent, use new action & afterContent
						// If the net result is no change, remove the entry
						if (newAction !== 'move' && beforeContent !== undefined && beforeContent === change.afterContent) {
							newMap.delete(change.path);
							return { pendingChanges: newMap };
						}
						newMap.set(change.path, { ...change, beforeContent, snapshotId, status: 'pending' });
						return { pendingChanges: newMap };
					}),

				approveChange: (path) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (change) {
							newMap.set(path, { ...change, status: 'approved' });
						}
						return { pendingChanges: newMap };
					}),

				rejectChange: (path) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (change) {
							newMap.set(path, { ...change, status: 'rejected' });
						}
						return { pendingChanges: newMap };
					}),

				approveAllChanges: () =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							if (value.status === 'pending') {
								newMap.set(key, { ...value, status: 'approved' });
							} else {
								newMap.set(key, value);
							}
						}
						return { pendingChanges: newMap };
					}),

				rejectAllChanges: () =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							if (value.status === 'pending') {
								newMap.set(key, { ...value, status: 'rejected' });
							} else {
								newMap.set(key, value);
							}
						}
						return { pendingChanges: newMap };
					}),

				clearPendingChanges: () => set({ pendingChanges: new Map() }),

				associateSnapshotWithPending: (snapshotId) =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							if (value.snapshotId) {
								newMap.set(key, value);
							} else {
								newMap.set(key, { ...value, snapshotId });
							}
						}
						return { pendingChanges: newMap };
					}),

				// =============================================================================
				// UI State & Actions
				// =============================================================================
				sidebarVisible: true,
				utilityPanelVisible: true,
				aiPanelVisible: false,
				devtoolsVisible: false,
				colorScheme: 'dark',
				activeMobilePanel: 'editor',
				mobileFileTreeOpen: false,
				activeSidebarView: 'explorer',
				toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

				toggleUtilityPanel: () => set((state) => ({ utilityPanelVisible: !state.utilityPanelVisible })),

				toggleAIPanel: () => set((state) => ({ aiPanelVisible: !state.aiPanelVisible })),

				toggleDevtools: () => set((state) => ({ devtoolsVisible: !state.devtoolsVisible })),

				setColorScheme: (scheme) => set({ colorScheme: scheme }),

				setActiveMobilePanel: (panel) => set({ activeMobilePanel: panel }),

				toggleMobileFileTree: () => set((state) => ({ mobileFileTreeOpen: !state.mobileFileTreeOpen })),

				setActiveSidebarView: (view) => set({ activeSidebarView: view }),

				// =============================================================================
				// Git State & Actions
				// =============================================================================
				gitStatus: [],
				gitBranches: [],
				gitStatusLoading: false,
				gitInitialized: false,

				setGitStatus: (entries) => set({ gitStatus: entries }),

				setGitBranches: (branches) => set({ gitBranches: branches }),

				setGitStatusLoading: (loading) => set({ gitStatusLoading: loading }),

				setGitInitialized: (initialized) => set({ gitInitialized: initialized }),
			}),
			{
				name: 'worker-ide-store',
				// Persist UI preferences and the active session ID so the
				// session can be restored after a page refresh.
				partialize: (state) => ({
					sidebarVisible: state.sidebarVisible,
					utilityPanelVisible: state.utilityPanelVisible,
					aiPanelVisible: state.aiPanelVisible,
					devtoolsVisible: state.devtoolsVisible,
					colorScheme: state.colorScheme,
					activeMobilePanel: state.activeMobilePanel,
					activeSidebarView: state.activeSidebarView,
					expandedDirs: [...state.expandedDirs],
					sessionId: state.sessionId,
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
export const selectPendingChanges = (state: StoreState) => state.pendingChanges;
export const selectColorScheme = (state: StoreState) => state.colorScheme;
export const selectHasPendingChanges = (state: StoreState) => {
	for (const change of state.pendingChanges.values()) {
		if (change.status === 'pending') return true;
	}
	return false;
};
export const selectGitStatus = (state: StoreState) => state.gitStatus;
export const selectGitBranches = (state: StoreState) => state.gitBranches;
export const selectGitStatusLoading = (state: StoreState) => state.gitStatusLoading;
export const selectGitInitialized = (state: StoreState) => state.gitInitialized;
export const selectActiveSidebarView = (state: StoreState) => state.activeSidebarView;
export const selectCurrentBranch = (state: StoreState) => state.gitBranches.find((branch) => branch.isCurrent);
export const selectGitChangedFileCount = (state: StoreState) => state.gitStatus.filter((entry) => entry.status !== 'unmodified').length;
