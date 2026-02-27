import { Suspense } from 'react';
import { expect, fn, within } from 'storybook/test';

import { MobileLayout } from './mobile-layout';

import type { useEditorState } from './use-editor-state';
import type { useFileTree } from '@/features/file-tree';
import type { LogCounts } from '@/features/output';
import type { Meta, StoryObj } from '@storybook/react-vite';

const mockChangeReview = {
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
	editorContent: 'console.log("Mobile!");',
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

const defaultMockLogCounts: LogCounts = { errors: 1, warnings: 2, logs: 5 };

const meta = {
	title: 'IDE/MobileLayout',
	component: MobileLayout,
	parameters: {
		layout: 'fullscreen',
		viewport: { defaultViewport: 'mobile1' },
	},
	tags: ['autodocs'],
	args: {
		projectId: 'test-project',
		resolvedTheme: 'dark',
		editorState: defaultMockEditorState,
		fileTree: defaultMockFileTree,
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
} satisfies Meta<typeof MobileLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

export const DefaultEditorView: Story = {
	play: async ({ canvasElement, step }) => {
		const canvas = within(canvasElement);
		await step('Verify editor is visible by default', async () => {
			await expect(await canvas.findByText('main.ts')).toBeInTheDocument();
		});
		await step('Verify Output summary button is visible', async () => {
			// Find the text loosely
			const outputButton = await canvas.findByText(/Output/i, {}, { timeout: 5000 });
			await expect(outputButton).toBeInTheDocument();
		});
	},
};
