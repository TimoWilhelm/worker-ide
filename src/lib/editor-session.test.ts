/**
 * Unit tests for the editor session persistence utilities.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { loadEditorSession, resolveEditorSession, saveEditorSession } from './editor-session';

import type { EditorSessionParsed } from '@shared/validation';

// =============================================================================
// Mock localStorage
// =============================================================================

const localStorageMock = (() => {
	let store: Record<string, string> = {};
	return {
		getItem: vi.fn((key: string) => store[key]),
		setItem: vi.fn((key: string, value: string) => {
			store[key] = value;
		}),
		removeItem: vi.fn((key: string) => {
			delete store[key];
		}),
		clear: vi.fn(() => {
			store = {};
		}),
	};
})();

beforeEach(() => {
	Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock, writable: true });
	localStorageMock.clear();
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

// =============================================================================
// loadEditorSession
// =============================================================================

describe('loadEditorSession', () => {
	it('returns undefined when nothing is stored', () => {
		expect(loadEditorSession('test-project')).toBeUndefined();
	});

	it('returns undefined for malformed JSON', () => {
		localStorageMock.setItem('worker-ide-editor-session:test-project', '{bad json');
		expect(loadEditorSession('test-project')).toBeUndefined();
	});

	it('returns undefined for invalid schema', () => {
		localStorageMock.setItem('worker-ide-editor-session:test-project', JSON.stringify({ openFiles: 'not-an-array' }));
		expect(loadEditorSession('test-project')).toBeUndefined();
	});

	it('returns undefined when localStorage.getItem throws', () => {
		localStorageMock.getItem.mockImplementationOnce(() => {
			throw new Error('SecurityError');
		});
		expect(loadEditorSession('test-project')).toBeUndefined();
	});

	it('loads a valid session', () => {
		const session = {
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: '/src/main.ts',
			scrollPositions: { '/src/main.ts': 200 },
		};
		localStorageMock.setItem('worker-ide-editor-session:test-project', JSON.stringify(session));

		expect(loadEditorSession('test-project')).toEqual(session);
	});

	it('defaults scrollPositions when omitted', () => {
		localStorageMock.setItem(
			'worker-ide-editor-session:test-project',
			JSON.stringify({ openFiles: ['/src/main.ts'], activeFile: '/src/main.ts' }),
		);

		expect(loadEditorSession('test-project')).toEqual({
			openFiles: ['/src/main.ts'],
			activeFile: '/src/main.ts',
			scrollPositions: {},
		});
	});

	it('scopes sessions per project', () => {
		const sessionA = { openFiles: ['/a.ts'], activeFile: '/a.ts', scrollPositions: {} };
		const sessionB = { openFiles: ['/b.ts'], activeFile: '/b.ts', scrollPositions: {} };
		saveEditorSession('project-a', sessionA);
		saveEditorSession('project-b', sessionB);

		expect(loadEditorSession('project-a')).toEqual(sessionA);
		expect(loadEditorSession('project-b')).toEqual(sessionB);
	});

	it('strips unknown keys gracefully (forward-compat)', () => {
		localStorageMock.setItem(
			'worker-ide-editor-session:test-project',
			JSON.stringify({ openFiles: ['/src/main.ts'], activeFile: '/src/main.ts', scrollPositions: {}, unknownFutureField: 42 }),
		);

		const result = loadEditorSession('test-project');
		expect(result).toBeDefined();
		expect(result?.openFiles).toEqual(['/src/main.ts']);
	});
});

// =============================================================================
// saveEditorSession
// =============================================================================

describe('saveEditorSession', () => {
	it('writes a session to localStorage', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts'],
			activeFile: '/src/main.ts',
			scrollPositions: { '/src/main.ts': 0 },
		};
		saveEditorSession('test-project', session);

		expect(localStorageMock.setItem).toHaveBeenCalledWith('worker-ide-editor-session:test-project', JSON.stringify(session));
	});

	it('silently ignores QuotaExceededError', () => {
		localStorageMock.setItem.mockImplementationOnce(() => {
			throw new Error('QuotaExceededError');
		});

		expect(() => {
			saveEditorSession('test-project', { openFiles: [], scrollPositions: {} });
		}).not.toThrow();
	});
});

// =============================================================================
// resolveEditorSession — edge cases
// =============================================================================

describe('resolveEditorSession', () => {
	const existingPaths = new Set(['/src/main.ts', '/src/app.tsx', '/src/utils.ts']);

	it('returns undefined when session is undefined', () => {
		expect(resolveEditorSession(undefined, existingPaths)).toBeUndefined();
	});

	it('returns undefined when openFiles is empty', () => {
		expect(resolveEditorSession({ openFiles: [], scrollPositions: {} }, existingPaths)).toBeUndefined();
	});

	it('returns undefined when all persisted files have been deleted', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/deleted-a.ts', '/deleted-b.ts'],
			activeFile: '/deleted-a.ts',
			scrollPositions: { '/deleted-a.ts': 100 },
		};
		expect(resolveEditorSession(session, existingPaths)).toBeUndefined();
	});

	it('filters out deleted files from openFiles', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/deleted.ts', '/src/app.tsx'],
			activeFile: '/src/main.ts',
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.openFiles).toEqual(['/src/main.ts', '/src/app.tsx']);
	});

	it('falls back activeFile to first surviving tab when active file was deleted', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/deleted.ts', '/src/app.tsx', '/src/main.ts'],
			activeFile: '/deleted.ts',
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.activeFile).toBe('/src/app.tsx');
		expect(result?.openFiles).toEqual(['/src/app.tsx', '/src/main.ts']);
	});

	it('falls back activeFile when it is not in openFiles (corrupt data)', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: '/src/utils.ts', // exists on disk but not in openFiles
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.activeFile).toBe('/src/main.ts');
	});

	it('keeps activeFile when it exists and is in openFiles', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: '/src/app.tsx',
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.activeFile).toBe('/src/app.tsx');
	});

	it('discards scroll positions for deleted files', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/deleted.ts'],
			activeFile: '/src/main.ts',
			scrollPositions: {
				'/src/main.ts': 150,
				'/deleted.ts': 300,
			},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.scrollPositions.get('/src/main.ts')).toBe(150);
		expect(result?.scrollPositions.has('/deleted.ts')).toBe(false);
	});

	it('discards scroll positions for files that exist but are not in openFiles', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts'],
			activeFile: '/src/main.ts',
			scrollPositions: {
				'/src/main.ts': 100,
				'/src/app.tsx': 200, // exists on disk but not an open tab
			},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.scrollPositions.has('/src/app.tsx')).toBe(false);
		expect(result?.scrollPositions.get('/src/main.ts')).toBe(100);
	});

	it('preserves tab order of surviving files', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/utils.ts', '/deleted.ts', '/src/main.ts', '/also-deleted.ts', '/src/app.tsx'],
			activeFile: '/src/main.ts',
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.openFiles).toEqual(['/src/utils.ts', '/src/main.ts', '/src/app.tsx']);
	});

	it('handles session with no activeFile set', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: undefined,
			scrollPositions: {},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result?.activeFile).toBe('/src/main.ts');
	});

	it('handles empty existingPaths (empty project)', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts'],
			activeFile: '/src/main.ts',
			scrollPositions: { '/src/main.ts': 50 },
		};

		expect(resolveEditorSession(session, new Set())).toBeUndefined();
	});

	it('returns correct result when all files survive', () => {
		const session: EditorSessionParsed = {
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: '/src/app.tsx',
			scrollPositions: {
				'/src/main.ts': 100,
				'/src/app.tsx': 200,
			},
		};

		const result = resolveEditorSession(session, existingPaths);
		expect(result).toEqual({
			openFiles: ['/src/main.ts', '/src/app.tsx'],
			activeFile: '/src/app.tsx',
			scrollPositions: new Map([
				['/src/main.ts', 100],
				['/src/app.tsx', 200],
			]),
		});
	});
});
