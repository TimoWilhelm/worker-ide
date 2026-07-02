import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStore } from '@/lib/store';

import { useEditorSessionPersistence } from './use-editor-session-persistence';

const loadEditorSession = vi.fn();
const saveEditorSession = vi.fn();
const resolveEditorSession = vi.fn();

vi.mock('@/lib/editor-session', () => ({
	loadEditorSession: (...arguments_: unknown[]) => loadEditorSession(...arguments_),
	saveEditorSession: (...arguments_: unknown[]) => saveEditorSession(...arguments_),
	resolveEditorSession: (...arguments_: unknown[]) => resolveEditorSession(...arguments_),
}));

describe('useEditorSessionPersistence', () => {
	beforeEach(() => {
		loadEditorSession.mockReset();
		saveEditorSession.mockReset();
		resolveEditorSession.mockReset();
		useStore.setState({
			files: [{ path: '/src/leftover.ts', name: 'leftover.ts', isDirectory: false }],
			isLoading: false,
			openFiles: ['/src/leftover.ts'],
			activeFile: '/src/leftover.ts',
			unsavedChanges: new Map(),
			fileScrollPositions: new Map(),
			fileCursorPositions: new Map(),
		});
	});

	it('clears stale editor state when the project has no session to restore', () => {
		const { unmount } = renderHook(() => useEditorSessionPersistence({ projectId: 'project-new' }));

		expect(useStore.getState().openFiles).toEqual([]);
		expect(useStore.getState().activeFile).toBeUndefined();

		unmount();
	});

	it('restores the persisted session when one exists', () => {
		resolveEditorSession.mockReturnValue({
			openFiles: ['/src/a.ts'],
			activeFile: '/src/a.ts',
			scrollPositions: new Map(),
			cursorPositions: new Map(),
		});

		const { unmount } = renderHook(() => useEditorSessionPersistence({ projectId: 'project-existing' }));

		expect(useStore.getState().openFiles).toEqual(['/src/a.ts']);
		expect(useStore.getState().activeFile).toBe('/src/a.ts');

		unmount();
	});
});
