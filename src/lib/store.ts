import { create } from 'zustand';
import { devtools, persist } from 'zustand/middleware';

import { DEFAULT_AI_MODEL, DEFAULT_EDITOR_FONT, type AIModelId, type EditorFont } from '@shared/constants';
import { persistedStoreSchema } from '@shared/validation';

import type {
	PreviewElementReference,
	AgentMode,
	FileInfo,
	GitBranchInfo,
	GitStatusEntry,
	Participant,
	PendingFileChange,
	SnapshotSummary,
	ChatMessage,
} from '@shared/types';

interface EditorState {
	activeFile: string | undefined;
	openFiles: string[];
	cursorPosition: { line: number; column: number } | undefined;
	pendingGoTo: { line: number; column: number } | undefined;
	unsavedChanges: Map<string, boolean>;
	fileScrollPositions: Map<string, number>;
	fileCursorPositions: Map<string, { line: number; column: number }>;
}

interface EditorActions {
	setActiveFile: (path: string | undefined) => void;
	openFile: (path: string) => void;
	closeFile: (path: string) => void;
	setCursorPosition: (position: { line: number; column: number } | undefined) => void;
	goToFilePosition: (path: string, position: { line: number; column: number }) => void;
	clearPendingGoTo: () => void;
	markFileChanged: (path: string, changed: boolean) => void;
	closeAllFiles: () => void;
	setFileScrollPosition: (path: string, scrollTop: number) => void;
	restoreFileScrollPositions: (positions: Map<string, number>) => void;
	setFileCursorPosition: (path: string, position: { line: number; column: number }) => void;
}

interface FileTreeState {
	files: FileInfo[];
	selectedFile: string | undefined;
	expandedDirs: Set<string>;
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

interface AIError {
	message: string;
	code?: string;
}

interface AIState {
	history: ChatMessage[];
	isProcessing: boolean;
	statusMessage: string | undefined;
	aiError: AIError | undefined;
	sessionId: string | undefined;
	savedSessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>;
	agentMode: AgentMode;
	selectedModel: AIModelId;
	debugLogId: string | undefined;
	contextTokensUsed: number;
	runningSessionIds: Set<string>;
	pendingPreviewElementReferences: PreviewElementReference[];
}

interface AIActions {
	addMessage: (message: ChatMessage) => void;
	clearHistory: () => void;
	setProcessing: (processing: boolean) => void;
	setStatusMessage: (message: string | undefined) => void;
	setAiError: (error: AIError | undefined) => void;
	setSessionId: (id: string | undefined) => void;
	setSavedSessions: (sessions: Array<{ id: string; title: string; createdAt: number; isRunning: boolean }>) => void;
	setAgentMode: (mode: AgentMode) => void;
	setSelectedModel: (model: AIModelId) => void;
	setDebugLogId: (id: string | undefined) => void;
	setContextTokensUsed: (tokens: number) => void;
	addRunningSession: (sessionId: string) => void;
	removeRunningSession: (sessionId: string) => void;
	setRunningSessionIds: (ids: Set<string>) => void;
	queuePreviewElementReference: (reference: PreviewElementReference) => void;
	shiftPendingPreviewElementReference: () => void;
}

interface CollaborationState {
	participants: Participant[];
	localParticipantId: string | undefined;
	localParticipantColor: string | undefined;
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

interface SnapshotState {
	snapshots: SnapshotSummary[];
	activeSnapshot: string | undefined;
}

interface SnapshotActions {
	setSnapshots: (snapshots: SnapshotSummary[]) => void;
	addSnapshot: (snapshot: SnapshotSummary) => void;
	setActiveSnapshot: (id: string | undefined) => void;
}

interface PendingChangesState {
	pendingChanges: Map<string, PendingFileChange>;
}

interface PendingChangesActions {
	addPendingChange: (change: Omit<PendingFileChange, 'status' | 'hunkStatuses'>) => void;
	approveChange: (path: string) => void;
	rejectChange: (path: string) => void;
	approveHunk: (path: string, groupIndex: number) => void;
	rejectHunk: (path: string, groupIndex: number) => void;
	approveAllChanges: (sessionId?: string) => void;
	rejectAllChanges: (sessionId?: string) => void;
	clearPendingChanges: () => void;
	clearPendingChangesByPaths: (paths: Set<string>, sessionId?: string) => void;
	loadPendingChanges: (changes: Map<string, PendingFileChange>) => void;
}

interface IdentityState {
	optimisticUserName: string | undefined;
	optimisticOrganizationNames: Record<string, string>;
}

interface IdentityActions {
	setOptimisticUserName: (name: string | undefined) => void;
	setOptimisticOrganizationName: (organizationId: string, name: string | undefined) => void;
}

type ColorScheme = 'light' | 'dark' | 'system';

export type MobilePanel = 'editor' | 'preview' | 'git' | 'agent' | 'tests';

export type SidebarView = 'explorer' | 'git' | 'tests';

export type UtilityTab = 'output';

interface UIState {
	sidebarVisible: boolean;
	utilityPanelVisible: boolean;
	agentPanelVisible: boolean;
	requestedAgentSessionId: string | undefined;
	devtoolsVisible: boolean;
	dependenciesPanelVisible: boolean;
	colorScheme: ColorScheme;
	editorFont: EditorFont;
	activeMobilePanel: MobilePanel;
	mobileFileTreeOpen: boolean;
	activeSidebarView: SidebarView;
	activeUtilityTab: UtilityTab;
}

interface UIActions {
	toggleSidebar: () => void;
	toggleUtilityPanel: () => void;
	toggleAgentPanel: () => void;
	showAgentPanel: () => void;
	requestAgentSession: (sessionId: string) => void;
	clearRequestedAgentSession: () => void;
	toggleDevtools: () => void;
	toggleDependenciesPanel: () => void;
	setColorScheme: (scheme: ColorScheme) => void;
	setEditorFont: (font: EditorFont) => void;
	setActiveMobilePanel: (panel: MobilePanel) => void;
	toggleMobileFileTree: () => void;
	setActiveSidebarView: (view: SidebarView) => void;
	showDependenciesPanel: () => void;
	showUtilityPanel: (tab: UtilityTab) => void;
}

/**
 * Read-only diff view for displaying git file diffs in the editor.
 * Separate from `pendingChanges` (which is for AI change review with accept/reject).
 */
interface GitDiffView {
	path: string;
	beforeContent: string;
	afterContent: string;
	description?: string;
}

interface GitState {
	gitStatus: GitStatusEntry[];
	gitBranches: GitBranchInfo[];
	gitStatusLoading: boolean;
	gitInitialized: boolean;
	gitDiffView: GitDiffView | undefined;
}

interface GitActions {
	setGitStatus: (entries: GitStatusEntry[]) => void;
	setGitBranches: (branches: GitBranchInfo[]) => void;
	setGitStatusLoading: (loading: boolean) => void;
	setGitInitialized: (initialized: boolean) => void;
	showGitDiff: (diffView: GitDiffView) => void;
	clearGitDiff: () => void;
}

type StoreState = EditorState &
	FileTreeState &
	AIState &
	CollaborationState &
	SnapshotState &
	PendingChangesState &
	IdentityState &
	UIState &
	GitState &
	EditorActions &
	FileTreeActions &
	AIActions &
	CollaborationActions &
	SnapshotActions &
	PendingChangesActions &
	IdentityActions &
	UIActions &
	GitActions;

/**
 * Parse and rehydrate persisted state from localStorage.
 * Uses Zod to strip unknown keys and reject malformed data.
 * Converts expandedDirs from persisted array back to Set.
 */
function rehydratePersistedState(state: StoreState | undefined): void {
	if (!state) return;

	// Zustand persist stores the partialized shape under `state`.
	// Parse the fields that came from localStorage.
	const result = persistedStoreSchema.safeParse(state);
	if (result.success) {
		state.sidebarVisible = result.data.sidebarVisible;
		state.utilityPanelVisible = result.data.utilityPanelVisible;
		state.agentPanelVisible = result.data.agentPanelVisible;
		state.devtoolsVisible = result.data.devtoolsVisible;
		state.dependenciesPanelVisible = result.data.dependenciesPanelVisible;
		state.colorScheme = result.data.colorScheme;
		state.expandedDirs = new Set(result.data.expandedDirs);
		// Apply defaults for fields that may be missing in older persisted data
		state.editorFont = result.data.editorFont;
		state.activeMobilePanel = result.data.activeMobilePanel;
		state.activeSidebarView = result.data.activeSidebarView;
		state.selectedModel = result.data.selectedModel;
	} else {
		// Persisted data is corrupt — reset to defaults
		state.expandedDirs = new Set(['/src', '/worker']);
		state.sidebarVisible = true;
		state.utilityPanelVisible = true;
		state.agentPanelVisible = false;
		state.devtoolsVisible = false;
		state.dependenciesPanelVisible = true;
		state.colorScheme = 'dark';
		state.editorFont = DEFAULT_EDITOR_FONT;
		state.activeMobilePanel = 'editor';
		state.activeSidebarView = 'explorer';
		state.selectedModel = DEFAULT_AI_MODEL;
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
				fileScrollPositions: new Map(),
				fileCursorPositions: new Map(),

				setActiveFile: (path) => set({ activeFile: path, cursorPosition: undefined }),

				openFile: (path) =>
					set((state) => ({
						openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
						activeFile: path,
						activeMobilePanel: 'editor',
						cursorPosition: undefined,
					})),

				closeFile: (path) =>
					set((state) => {
						const newOpenFiles = state.openFiles.filter((f) => f !== path);
						const newUnsavedChanges = new Map(state.unsavedChanges);
						newUnsavedChanges.delete(path);
						const newFileScrollPositions = new Map(state.fileScrollPositions);
						newFileScrollPositions.delete(path);
						const newFileCursorPositions = new Map(state.fileCursorPositions);
						newFileCursorPositions.delete(path);
						return {
							openFiles: newOpenFiles,
							activeFile: state.activeFile === path ? newOpenFiles.at(-1) : state.activeFile,
							unsavedChanges: newUnsavedChanges,
							fileScrollPositions: newFileScrollPositions,
							fileCursorPositions: newFileCursorPositions,
						};
					}),

				setCursorPosition: (position) => set({ cursorPosition: position }),

				goToFilePosition: (path, position) =>
					set((state) => ({
						openFiles: state.openFiles.includes(path) ? state.openFiles : [...state.openFiles, path],
						activeFile: path,
						activeMobilePanel: 'editor',
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
						fileScrollPositions: new Map(),
						fileCursorPositions: new Map(),
					}),

				setFileScrollPosition: (path, scrollTop) =>
					set((state) => {
						const newMap = new Map(state.fileScrollPositions);
						newMap.set(path, scrollTop);
						return { fileScrollPositions: newMap };
					}),

				restoreFileScrollPositions: (positions) => set({ fileScrollPositions: positions }),

				setFileCursorPosition: (path, position) =>
					set((state) => {
						const newMap = new Map(state.fileCursorPositions);
						newMap.set(path, position);
						return { fileCursorPositions: newMap };
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
				agentMode: 'code',
				selectedModel: DEFAULT_AI_MODEL,
				debugLogId: undefined,
				contextTokensUsed: 0,
				runningSessionIds: new Set(),
				pendingPreviewElementReferences: [],

				addMessage: (message) =>
					set((state) => ({
						history: [...state.history, message],
					})),

				clearHistory: () =>
					set({
						history: [],
						sessionId: undefined,
						aiError: undefined,
						debugLogId: undefined,
						contextTokensUsed: 0,
					}),

				setProcessing: (processing) => set({ isProcessing: processing }),

				setStatusMessage: (message) => set({ statusMessage: message }),

				setAiError: (error) => set({ aiError: error }),

				setSessionId: (id) => set({ sessionId: id }),

				setSavedSessions: (sessions) => set({ savedSessions: sessions }),
				setAgentMode: (mode) => set({ agentMode: mode }),

				setSelectedModel: (model) => set({ selectedModel: model }),

				setDebugLogId: (id) => set({ debugLogId: id }),

				setContextTokensUsed: (tokens) => set({ contextTokensUsed: tokens }),

				addRunningSession: (sessionId) =>
					set((state) => {
						const next = new Set(state.runningSessionIds);
						next.add(sessionId);
						return { runningSessionIds: next };
					}),

				removeRunningSession: (sessionId) =>
					set((state) => {
						const next = new Set(state.runningSessionIds);
						next.delete(sessionId);
						return { runningSessionIds: next };
					}),

				setRunningSessionIds: (ids) => set({ runningSessionIds: ids }),

				queuePreviewElementReference: (reference) =>
					set((state) => ({ pendingPreviewElementReferences: [...state.pendingPreviewElementReferences, reference] })),

				shiftPendingPreviewElementReference: () =>
					set((state) => ({ pendingPreviewElementReferences: state.pendingPreviewElementReferences.slice(1) })),

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
							newMap.set(change.path, { ...change, status: 'pending', hunkStatuses: [] });
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
								hunkStatuses: [],
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
								hunkStatuses: [],
							});
							return { pendingChanges: newMap };
						}

						// All other cases: keep original beforeContent, use new action & afterContent
						// If the net result is no change, remove the entry
						if (newAction !== 'move' && beforeContent !== undefined && beforeContent === change.afterContent) {
							newMap.delete(change.path);
							return { pendingChanges: newMap };
						}
						newMap.set(change.path, { ...change, beforeContent, snapshotId, status: 'pending', hunkStatuses: [] });
						return { pendingChanges: newMap };
					}),

				approveChange: (path) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (change) {
							newMap.set(path, {
								...change,
								status: 'approved',
								hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'approved' : status)),
							});
						}
						return { pendingChanges: newMap };
					}),

				rejectChange: (path) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (change) {
							newMap.set(path, {
								...change,
								status: 'rejected',
								hunkStatuses: change.hunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status)),
							});
						}
						return { pendingChanges: newMap };
					}),

				approveHunk: (path, groupIndex) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (!change) return { pendingChanges: newMap };

						const newStatuses = [...change.hunkStatuses];
						newStatuses[groupIndex] = 'approved';

						// If all hunks are resolved (no pending left), mark the whole file.
						// Mixed decisions (some approved, some rejected) are treated as 'approved'
						// since the user explicitly approved this hunk — partial accept beats stuck pending.
						const allResolved = newStatuses.every((status) => status !== 'pending');

						newMap.set(path, {
							...change,
							hunkStatuses: newStatuses,
							status: allResolved ? 'approved' : 'pending',
						});
						return { pendingChanges: newMap };
					}),

				rejectHunk: (path, groupIndex) =>
					set((state) => {
						const newMap = new Map(state.pendingChanges);
						const change = newMap.get(path);
						if (!change) return { pendingChanges: newMap };

						const newStatuses = [...change.hunkStatuses];
						newStatuses[groupIndex] = 'rejected';

						// If all hunks are resolved (no pending left), mark the whole file
						// If all hunks are resolved (no pending left), mark the whole file.
						// Mixed decisions (some approved, some rejected) are treated as 'rejected'
						// since the user explicitly rejected this hunk — partial reject beats stuck pending.
						const allResolved = newStatuses.every((status) => status !== 'pending');

						newMap.set(path, {
							...change,
							hunkStatuses: newStatuses,
							status: allResolved ? 'rejected' : 'pending',
						});
						return { pendingChanges: newMap };
					}),

				approveAllChanges: (sessionId) =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							const matchesSession = !sessionId || value.sessionId === sessionId;
							if (value.status === 'pending' && matchesSession) {
								newMap.set(key, {
									...value,
									status: 'approved',
									hunkStatuses: value.hunkStatuses.map((status) => (status === 'pending' ? 'approved' : status)),
								});
							} else {
								newMap.set(key, value);
							}
						}
						return { pendingChanges: newMap };
					}),

				rejectAllChanges: (sessionId) =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							const matchesSession = !sessionId || value.sessionId === sessionId;
							if (value.status === 'pending' && matchesSession) {
								newMap.set(key, {
									...value,
									status: 'rejected',
									hunkStatuses: value.hunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status)),
								});
							} else {
								newMap.set(key, value);
							}
						}
						return { pendingChanges: newMap };
					}),

				clearPendingChanges: () => set({ pendingChanges: new Map() }),

				clearPendingChangesByPaths: (paths, sessionId) =>
					set((state) => {
						const newMap = new Map<string, PendingFileChange>();
						for (const [key, value] of state.pendingChanges) {
							const matchesPath = paths.has(key);
							const matchesSession = sessionId === undefined || value.sessionId === sessionId;
							if (!(matchesPath && matchesSession)) {
								newMap.set(key, value);
							}
						}
						return { pendingChanges: newMap };
					}),

				loadPendingChanges: (changes) => set({ pendingChanges: changes }),

				// =============================================================================
				// Identity State & Actions
				// =============================================================================
				optimisticUserName: undefined,
				optimisticOrganizationNames: {},

				setOptimisticUserName: (name) => set({ optimisticUserName: name }),

				setOptimisticOrganizationName: (organizationId, name) =>
					set((state) => {
						const optimisticOrganizationNames = { ...state.optimisticOrganizationNames };
						if (name === undefined) {
							delete optimisticOrganizationNames[organizationId];
						} else {
							optimisticOrganizationNames[organizationId] = name;
						}
						return { optimisticOrganizationNames };
					}),

				// =============================================================================
				// UI State & Actions
				// =============================================================================
				sidebarVisible: true,
				utilityPanelVisible: true,
				agentPanelVisible: false,
				requestedAgentSessionId: undefined,
				devtoolsVisible: false,
				dependenciesPanelVisible: true,
				colorScheme: 'dark',
				editorFont: DEFAULT_EDITOR_FONT,
				activeMobilePanel: 'editor',
				mobileFileTreeOpen: false,
				activeSidebarView: 'explorer',
				activeUtilityTab: 'output',
				toggleSidebar: () => set((state) => ({ sidebarVisible: !state.sidebarVisible })),

				toggleUtilityPanel: () => set((state) => ({ utilityPanelVisible: !state.utilityPanelVisible })),

				toggleAgentPanel: () => set((state) => ({ agentPanelVisible: !state.agentPanelVisible })),

				showAgentPanel: () => set({ agentPanelVisible: true, activeMobilePanel: 'agent' }),

				requestAgentSession: (sessionId) =>
					set({
						agentPanelVisible: true,
						activeMobilePanel: 'agent',
						requestedAgentSessionId: sessionId,
					}),

				clearRequestedAgentSession: () => set({ requestedAgentSessionId: undefined }),

				toggleDevtools: () => set((state) => ({ devtoolsVisible: !state.devtoolsVisible })),

				toggleDependenciesPanel: () => set((state) => ({ dependenciesPanelVisible: !state.dependenciesPanelVisible })),

				showDependenciesPanel: () => set({ dependenciesPanelVisible: true }),

				showUtilityPanel: (tab) => set({ utilityPanelVisible: true, activeUtilityTab: tab }),

				setColorScheme: (scheme) => set({ colorScheme: scheme }),

				setEditorFont: (font) => set({ editorFont: font }),

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
				gitDiffView: undefined,

				setGitStatus: (entries) => set({ gitStatus: entries }),

				setGitBranches: (branches) => set({ gitBranches: branches }),

				setGitStatusLoading: (loading) => set({ gitStatusLoading: loading }),

				setGitInitialized: (initialized) => set({ gitInitialized: initialized }),

				showGitDiff: (diffView) =>
					set((state) => ({
						gitDiffView: diffView,
						// Also open the file and make it active so the editor shows it
						openFiles: state.openFiles.includes(diffView.path) ? state.openFiles : [...state.openFiles, diffView.path],
						activeFile: diffView.path,
						activeMobilePanel: 'editor',
					})),

				clearGitDiff: () => set({ gitDiffView: undefined }),
			}),
			{
				name: 'worker-ide-store',
				// Persist UI preferences only. The active session ID is stored
				// in localStorage scoped per project to avoid cross-project leakage.
				partialize: (state) => ({
					sidebarVisible: state.sidebarVisible,
					utilityPanelVisible: state.utilityPanelVisible,
					agentPanelVisible: state.agentPanelVisible,
					devtoolsVisible: state.devtoolsVisible,
					dependenciesPanelVisible: state.dependenciesPanelVisible,
					colorScheme: state.colorScheme,
					editorFont: state.editorFont,
					activeMobilePanel: state.activeMobilePanel,
					activeSidebarView: state.activeSidebarView,
					activeUtilityTab: state.activeUtilityTab,
					expandedDirs: [...state.expandedDirs],
					selectedModel: state.selectedModel,
				}),
				// Rehydrate expandedDirs as Set
				onRehydrateStorage: () => rehydratePersistedState,
			},
		),
		{ name: 'WorkerIDE' },
	),
);

export const selectIsProcessing = (state: StoreState) => state.isProcessing;
export const selectColorScheme = (state: StoreState) => state.colorScheme;
export const selectEditorFont = (state: StoreState) => state.editorFont;
export const selectGitStatus = (state: StoreState) => state.gitStatus;
export const selectActiveSidebarView = (state: StoreState) => state.activeSidebarView;
export const selectGitChangedFileCount = (state: StoreState) => state.gitStatus.filter((entry) => entry.status !== 'unmodified').length;
export const selectGitDiffView = (state: StoreState) => state.gitDiffView;
export const selectOptimisticUserName = (state: StoreState) => state.optimisticUserName;
