import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { projectSocketSendReference } from '@/hooks';
import { useStore } from '@/lib/store';

import { useEditorState } from './use-editor-state';

vi.mock('@/features/agent/hooks/use-change-review', () => ({
	useChangeReview: () => ({}),
}));

vi.mock('@/features/editor', () => ({
	computeDiffData: vi.fn(),
	computeRebasedDiffData: vi.fn(),
	groupHunksIntoChanges: vi.fn(() => []),
	useFileContent: () => ({
		content: 'old content',
		isLoading: false,
		saveFile: vi.fn(),
		isSaving: false,
	}),
}));

describe('useEditorState', () => {
	beforeEach(() => {
		useStore.setState({
			activeFile: '/src/app.ts',
			openFiles: ['/src/app.ts'],
			unsavedChanges: new Map(),
			pendingChanges: new Map(),
			cursorPosition: undefined,
			gitDiffView: undefined,
		});
	});

	afterEach(() => {
		projectSocketSendReference.current = undefined;
	});

	it('broadcasts editor content changes over the project socket immediately', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('new content');
		});

		expect(send).toHaveBeenCalledTimes(1);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'new content' });
		expect(useStore.getState().unsavedChanges.get('/src/app.ts')).toBe(true);

		unmount();
	});

	it('broadcasts every editor content change without timeout batching', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('first');
			result.current.handleEditorChange('second');
		});

		expect(send).toHaveBeenCalledTimes(2);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'first' });
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'second' });

		unmount();
	});

	it('broadcasts cursor metadata with editor content changes', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('selected content', { line: 2, column: 5, anchorLine: 2, anchorColumn: 1 });
		});

		expect(send).toHaveBeenCalledWith({
			type: 'file-edit',
			path: '/src/app.ts',
			content: 'selected content',
			cursor: { line: 2, ch: 5 },
			selection: { anchor: { line: 2, ch: 1 }, head: { line: 2, ch: 5 } },
		});
		expect(useStore.getState().cursorPosition).toEqual({ line: 2, column: 5 });
		expect(useStore.getState().fileCursorPositions.get('/src/app.ts')).toEqual({ line: 2, column: 5 });

		unmount();
	});

	it('does not fold human edits into pending agent diff content', () => {
		const send = vi.fn();
		projectSocketSendReference.current = send;
		useStore.setState({
			pendingChanges: new Map([
				[
					'/src/app.ts',
					{
						path: '/src/app.ts',
						action: 'edit',
						beforeContent: 'old content',
						afterContent: 'agent content',
						snapshotId: undefined,
						status: 'pending',
						hunkStatuses: ['pending'],
						sessionId: 'session-1',
					},
				],
			]),
		});
		const { result, unmount } = renderHook(() => useEditorState({ projectId: 'project-1' }));

		act(() => {
			result.current.handleEditorChange('human content');
		});

		expect(useStore.getState().pendingChanges.get('/src/app.ts')?.afterContent).toBe('agent content');
		expect(useStore.getState().unsavedChanges.get('/src/app.ts')).toBe(true);
		expect(send).toHaveBeenCalledWith({ type: 'file-edit', path: '/src/app.ts', content: 'human content' });

		unmount();
	});
});
