import { describe, expect, it, vi } from 'vitest';

import { openFileTarget, resolveFileTargetPath } from './file-target';

describe('resolveFileTargetPath', () => {
	it('normalizes relative paths when the file list does not contain an exact match', () => {
		expect(resolveFileTargetPath('src/main.ts', [{ path: '/src/app.tsx' }])).toBe('/src/main.ts');
	});

	it('normalizes duplicate leading slashes to the canonical file path', () => {
		expect(resolveFileTargetPath('//src//app.tsx', [{ path: '/src/app.tsx' }])).toBe('/src/app.tsx');
	});
});

describe('openFileTarget', () => {
	it('reveals and opens plain file targets', () => {
		const expandDirectory = vi.fn();
		const goToFilePosition = vi.fn();
		const openFile = vi.fn();
		const setActiveSidebarView = vi.fn();

		openFileTarget(
			{ path: '/src/features/agent/components/file-reference.tsx' },
			[{ path: '/src/features/agent/components/file-reference.tsx' }],
			{ expandDirectory, goToFilePosition, openFile, setActiveSidebarView },
		);

		expect(setActiveSidebarView).toHaveBeenCalledWith('explorer');
		expect(expandDirectory).toHaveBeenNthCalledWith(1, '/src');
		expect(expandDirectory).toHaveBeenNthCalledWith(2, '/src/features');
		expect(expandDirectory).toHaveBeenNthCalledWith(3, '/src/features/agent');
		expect(expandDirectory).toHaveBeenNthCalledWith(4, '/src/features/agent/components');
		expect(openFile).toHaveBeenCalledWith('/src/features/agent/components/file-reference.tsx');
		expect(goToFilePosition).not.toHaveBeenCalled();
	});

	it('reveals and navigates to positioned file targets', () => {
		const expandDirectory = vi.fn();
		const goToFilePosition = vi.fn();
		const openFile = vi.fn();
		const setActiveSidebarView = vi.fn();

		openFileTarget({ path: 'src/main.ts', position: { line: 10, column: 5 } }, [{ path: '/src/main.ts' }], {
			expandDirectory,
			goToFilePosition,
			openFile,
			setActiveSidebarView,
		});

		expect(goToFilePosition).toHaveBeenCalledWith('/src/main.ts', { line: 10, column: 5 });
		expect(openFile).not.toHaveBeenCalled();
	});
});
