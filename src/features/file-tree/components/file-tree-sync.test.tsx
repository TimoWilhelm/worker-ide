import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
	const resetPaths = vi.fn();
	const setGitStatus = vi.fn();
	const setIcons = vi.fn();
	const scrollToPath = vi.fn();
	const getSelectedPaths = vi.fn((): string[] => []);
	const getFocusedPath = vi.fn();
	const getItem = vi.fn();
	const onSelectionChangeValues = {
		matchingPaths: [],
		isOpen: false,
		value: '',
		open: vi.fn(),
		close: vi.fn(),
		setValue: vi.fn(),
		focusNextMatch: vi.fn(),
		focusPreviousMatch: vi.fn(),
	};

	return {
		resetPaths,
		setGitStatus,
		setIcons,
		scrollToPath,
		getSelectedPaths,
		getFocusedPath,
		getItem,
		onSelectionChangeValues,
	};
});

vi.mock('@pierre/trees', () => ({
	prepareFileTreeInput: (paths: string[]) => paths,
}));

vi.mock('@pierre/trees/react', () => ({
	FileTree: ({ className }: { className?: string }) => <div data-testid="mock-tree" className={className} />,
	useFileTree: () => ({
		model: {
			resetPaths: mocks.resetPaths,
			setGitStatus: mocks.setGitStatus,
			setIcons: mocks.setIcons,
			scrollToPath: mocks.scrollToPath,
			getSelectedPaths: mocks.getSelectedPaths,
			getFocusedPath: mocks.getFocusedPath,
			getItem: mocks.getItem,
		},
	}),
	useFileTreeSearch: () => mocks.onSelectionChangeValues,
}));

import { TooltipProvider } from '@/components/ui/tooltip';

import { FileTree } from './file-tree';

import type { FileInfo } from '@shared/types';

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

describe('FileTree sync', () => {
	it('resets the model when files arrive after the initial empty render', () => {
		const onFileSelect = vi.fn();
		const onDirectoryToggle = vi.fn();
		const expandedDirectories = new Set(['/src']);
		const loadedFiles: FileInfo[] = [
			{ path: '/index.html', name: 'index.html', isDirectory: false },
			{ path: '/src/main.tsx', name: 'main.tsx', isDirectory: false },
		];

		const { rerender } = renderWithProviders(
			<FileTree
				files={[]}
				selectedFile={undefined}
				expandedDirectories={expandedDirectories}
				onFileSelect={onFileSelect}
				onDirectoryToggle={onDirectoryToggle}
			/>,
		);

		expect(mocks.resetPaths).not.toHaveBeenCalled();

		rerender(
			<TooltipProvider>
				<FileTree
					files={loadedFiles}
					selectedFile={undefined}
					expandedDirectories={expandedDirectories}
					onFileSelect={onFileSelect}
					onDirectoryToggle={onDirectoryToggle}
				/>
			</TooltipProvider>,
		);

		expect(mocks.resetPaths).toHaveBeenCalledWith(['index.html', 'src/main.tsx'], {
			initialExpandedPaths: ['src/'],
		});
	});
});
