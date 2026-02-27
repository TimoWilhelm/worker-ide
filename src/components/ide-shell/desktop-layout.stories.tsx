import { Suspense } from 'react';
import { expect, fn, within } from 'storybook/test';

import { DesktopLayout } from './desktop-layout';

import type { useEditorState } from './use-editor-state';
import type { usePanelLayouts } from './use-panel-layouts';
import type { useFileTree } from '@/features/file-tree';
import type { LogCounts } from '@/features/output';
import type { Meta, StoryObj } from '@storybook/react-vite';

const mockChangeReview: ReturnType<typeof useEditorState>['changeReview'] = {
	handleApproveChange: fn(),
	handleRejectChange: fn(),
	isReverting: false,
	canReject: true,
	handleApproveHunk: fn(),
	handleRejectHunk: fn(),
	pendingChanges: new Map(),
	unresolvedChanges: [],
	pendingCount: 0,
	sessionPendingCount: () => 0,
	handleRejectAll: fn(() => Promise.resolve()),
	handleApproveAll: fn(() => Promise.resolve()),
};

const defaultMockEditorState: ReturnType<typeof useEditorState> = {
	activeFile: 'src/main.ts',
	openFiles: ['src/main.ts'],
	unsavedChanges: new Map(),
	participants: [],
	cursorPosition: { line: 1, column: 1 },
	isLoadingContent: false,
	isSaving: false,
	editorContent: 'console.log("Desktop!");',
	tabs: [{ path: 'src/main.ts', hasUnsavedChanges: false, isSaving: false, label: 'main.ts' }],
	gitDiffView: undefined,
	clearGitDiff: fn(),
	isGitDiffActive: false,
	hasActiveDiff: false,
	activePendingChange: undefined,
	effectiveDiffData: undefined,
	changeReview: mockChangeReview,
	gitStatusMap: new Map(),
	handleEditorChange: fn(),
	handleSave: fn(() => Promise.resolve()),
	handleSaveReference: { current: fn(() => Promise.resolve()) },
	handleEditorBlur: fn(),
	handleViewReady: fn(),
	handlePrettify: fn(() => Promise.resolve()),
	isPrettifying: false,
	handleCloseFile: fn(),
	handleCursorChange: fn(),
	selectFileFromTree: fn(),
	cursorUpdateTimeoutReference: { current: undefined },
	pendingGoTo: undefined,
	clearPendingGoTo: fn(),
	goToFilePosition: fn(),
	pendingChanges: new Map(),
	markFileChanged: fn(),
	isLintableFile: () => true,
};

const defaultMockFileTree: ReturnType<typeof useFileTree> = {
	files: [
		{ name: 'src', path: 'src', isDirectory: true },
		{ name: 'main.ts', path: 'src/main.ts', isDirectory: false },
	],
	selectedFile: 'src/main.ts',
	expandedDirectories: new Set(['src']),
	isLoading: false,
	isError: false,
	error: undefined,
	refetch: fn(() => Promise.resolve()),
	isCreating: false,
	isDeleting: false,
	isRenaming: false,
	isCreatingFolder: false,
	selectFile: fn(),
	toggleDirectory: fn(),
	createFile: fn(),
	deleteFile: fn(),
	renameFile: fn(),
	createFolder: fn(),
};

const mockLayouts: ReturnType<typeof usePanelLayouts> = {
	aiPanelVisible: true,
	utilityPanelVisible: true,
	devtoolsVisible: false,
	dependenciesPanelVisible: true,
	mainLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	sidebarLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	editorTerminalLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
	previewDevtoolsLayout: { defaultLayout: undefined, onLayoutChanged: fn(), onLayoutChange: fn() },
};

const defaultMockLogCounts: LogCounts = { errors: 0, warnings: 0, logs: 0 };

const meta = {
	title: 'IDE/DesktopLayout',
	component: DesktopLayout,
	parameters: {
		layout: 'fullscreen',
	},
	tags: ['autodocs'],
	args: {
		projectId: 'test-project',
		resolvedTheme: 'dark',
		editorState: defaultMockEditorState,
		fileTree: defaultMockFileTree,
		layouts: mockLayouts,
		logCounts: defaultMockLogCounts,
		previewIframeReference: { current: document.createElement('iframe') },
	},
	decorators: [
		(Story) => (
			<Suspense fallback={<div>Loading...</div>}>
				<div className="flex h-dvh flex-col overflow-hidden bg-bg-primary">
					<Story />
				</div>
			</Suspense>
		),
	],
} satisfies Meta<typeof DesktopLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultView: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);
		await step('Verify editor tabs are visible', async () => {
			await expect(await canvas.findByText('main.ts')).toBeInTheDocument();
		});
		await step('Verify status bar is visible', async () => {
			await expect(await canvas.findByText('Disconnected')).toBeInTheDocument();
		});
	},
};
