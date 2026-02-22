/**
 * Unit tests for the FileTime service.
 *
 * Validates read-tracking, mtime-based assertion, and session clearing.
 * All filesystem calls are mocked since the module runs in a Worker isolate.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// =============================================================================
// Mock node:fs/promises
// =============================================================================

const fsMock = vi.hoisted(() => ({
	readFile: vi.fn().mockRejectedValue(new Error('ENOENT')),
	writeFile: vi.fn().mockResolvedValue(),
	rename: vi.fn().mockResolvedValue(),
	mkdir: vi.fn().mockResolvedValue(),
	stat: vi.fn(),
	rm: vi.fn().mockResolvedValue(),
}));

vi.mock('node:fs/promises', () => ({ default: fsMock }));

import { assertFileWasRead, clearSession, recordFileRead, withLock } from './file-time';

// =============================================================================
// Helpers
// =============================================================================

const PROJECT_ROOT = '/projects/test-project';
const SESSION_ID = 'session-1';

function makeStatResult(mtimeMs: number) {
	const mtime = new Date(mtimeMs);
	return { mtime, mtimeMs, size: 100, isFile: () => true, isDirectory: () => false };
}

// =============================================================================
// Tests
// =============================================================================

describe('FileTime', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// Stat returns a deterministic mtime by default
		fsMock.stat.mockResolvedValue(makeStatResult(1000));
	});

	afterEach(async () => {
		// Clear the in-memory cache between tests
		await clearSession(PROJECT_ROOT, SESSION_ID);
	});

	// =========================================================================
	// recordFileRead + assertFileWasRead: happy path
	// =========================================================================

	describe('sequential edits (happy path)', () => {
		it('allows assertFileWasRead after recordFileRead', async () => {
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');
			// mtime stays the same → should not throw
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();
		});

		it('allows multiple sequential edits to the same file', async () => {
			// Simulate: read → edit → edit → edit
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();

			// After a successful edit, recordFileRead is called again
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();

			// Third edit
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();
		});

		it('uses filesystem mtime instead of Date.now()', async () => {
			const filesystemMtime = 5000;
			fsMock.stat.mockResolvedValue(makeStatResult(filesystemMtime));

			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// The recorded value should be the filesystem mtime (5000), not Date.now().
			// If mtime stays at 5000, assert should pass.
			fsMock.stat.mockResolvedValue(makeStatResult(filesystemMtime));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();

			// If filesystem mtime moves forward (external modification), assert should fail.
			fsMock.stat.mockResolvedValue(makeStatResult(filesystemMtime + 1));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).rejects.toThrow('has been modified since');
		});

		it('falls back to Date.now() when stat fails during recordFileRead', async () => {
			fsMock.stat.mockRejectedValueOnce(new Error('ENOENT'));

			// Should not throw — falls back to Date.now()
			await expect(recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/new-file.ts')).resolves.toBeUndefined();

			// File now exists with an mtime in the past → assert should pass
			fsMock.stat.mockResolvedValue(makeStatResult(0));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/new-file.ts')).resolves.toBeUndefined();
		});
	});

	// =========================================================================
	// assertFileWasRead: file never read
	// =========================================================================

	describe('file never read', () => {
		it('throws when the file was never read', async () => {
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/unknown.ts')).rejects.toThrow(
				'You must read file /src/unknown.ts before overwriting it',
			);
		});

		it('error message includes the file_read tool hint', async () => {
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/unknown.ts')).rejects.toThrow('Use the file_read tool first');
		});
	});

	// =========================================================================
	// assertFileWasRead: file modified externally
	// =========================================================================

	describe('file modified externally', () => {
		it('throws when mtime is newer than recorded read time', async () => {
			const originalMtime = 1000;
			fsMock.stat.mockResolvedValue(makeStatResult(originalMtime));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// External modification bumps the mtime
			fsMock.stat.mockResolvedValue(makeStatResult(originalMtime + 100));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).rejects.toThrow('has been modified since it was last read');
		});

		it('passes when mtime equals recorded read time', async () => {
			const mtime = 1000;
			fsMock.stat.mockResolvedValue(makeStatResult(mtime));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// Same mtime → should pass (strict > comparison)
			fsMock.stat.mockResolvedValue(makeStatResult(mtime));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();
		});

		it('ignores stat failures during assert (file may have been deleted)', async () => {
			fsMock.stat.mockResolvedValueOnce(makeStatResult(1000));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// stat throws during assert → should pass (file may not exist yet)
			fsMock.stat.mockRejectedValue(new Error('ENOENT'));
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();
		});
	});

	// =========================================================================
	// Path normalization
	// =========================================================================

	describe('path normalization', () => {
		it('normalizes paths with and without leading slash', async () => {
			fsMock.stat.mockResolvedValue(makeStatResult(1000));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, 'src/app.ts');

			// Assert with leading slash should find the same entry
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).resolves.toBeUndefined();
		});

		it('normalizes paths recorded with leading slash', async () => {
			fsMock.stat.mockResolvedValue(makeStatResult(1000));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// Assert without leading slash should find the same entry
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, 'src/app.ts')).resolves.toBeUndefined();
		});
	});

	// =========================================================================
	// Session isolation
	// =========================================================================

	describe('session isolation', () => {
		it('tracks files independently per session', async () => {
			const otherSession = 'session-2';
			fsMock.stat.mockResolvedValue(makeStatResult(1000));

			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');

			// Same file in different session should not be found
			await expect(assertFileWasRead(PROJECT_ROOT, otherSession, '/src/app.ts')).rejects.toThrow('You must read file');

			// Clean up the other session
			await clearSession(PROJECT_ROOT, otherSession);
		});
	});

	// =========================================================================
	// clearSession
	// =========================================================================

	describe('clearSession', () => {
		it('removes all tracked files for a session', async () => {
			fsMock.stat.mockResolvedValue(makeStatResult(1000));
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts');
			await recordFileRead(PROJECT_ROOT, SESSION_ID, '/src/lib.ts');

			await clearSession(PROJECT_ROOT, SESSION_ID);

			// Both files should now be untracked
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/app.ts')).rejects.toThrow('You must read file');
			await expect(assertFileWasRead(PROJECT_ROOT, SESSION_ID, '/src/lib.ts')).rejects.toThrow('You must read file');
		});

		it('calls fs.rm to clean up the session directory', async () => {
			await clearSession(PROJECT_ROOT, SESSION_ID);

			expect(fsMock.rm).toHaveBeenCalledWith(`${PROJECT_ROOT}/.agent/sessions/${SESSION_ID}`, { recursive: true, force: true });
		});
	});

	// =========================================================================
	// withLock
	// =========================================================================

	describe('withLock', () => {
		it('serializes concurrent operations on the same file', async () => {
			const executionOrder: number[] = [];

			const operation1 = withLock('/src/app.ts', async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				executionOrder.push(1);
			});

			const operation2 = withLock('/src/app.ts', async () => {
				executionOrder.push(2);
			});

			await Promise.all([operation1, operation2]);

			// Operation 1 should complete before operation 2 starts
			expect(executionOrder).toEqual([1, 2]);
		});

		it('allows concurrent operations on different files', async () => {
			const executionOrder: number[] = [];

			const operation1 = withLock('/src/a.ts', async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				executionOrder.push(1);
			});

			const operation2 = withLock('/src/b.ts', async () => {
				executionOrder.push(2);
			});

			await Promise.all([operation1, operation2]);

			// Operation 2 on a different file should not wait for operation 1
			expect(executionOrder).toEqual([2, 1]);
		});

		it('releases lock even if the function throws', async () => {
			await expect(
				withLock('/src/app.ts', async () => {
					throw new Error('test error');
				}),
			).rejects.toThrow('test error');

			// Subsequent lock acquisition should work
			const result = await withLock('/src/app.ts', async () => 'success');
			expect(result).toBe('success');
		});
	});
});
