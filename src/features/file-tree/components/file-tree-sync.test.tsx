import { render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface MockUseFileTreeOptions {
	composition?: {
		contextMenu?: {
			buttonVisibility?: 'always' | 'when-needed';
		};
	};
	onSelectionChange?: (selectedPaths: readonly string[]) => void;
	dragAndDrop?: {
		canDrag?: (paths: readonly string[]) => boolean;
	};
}

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
	const useFileTree = vi.fn((_options: MockUseFileTreeOptions) => ({
		model: {
			resetPaths,
			setGitStatus,
			setIcons,
			scrollToPath,
			getSelectedPaths,
			getFocusedPath,
			getItem,
		},
	}));

	return {
		resetPaths,
		setGitStatus,
		setIcons,
		scrollToPath,
		getSelectedPaths,
		getFocusedPath,
		getItem,
		onSelectionChangeValues,
		useFileTree,
	};
});

vi.mock('@pierre/trees', () => ({
	prepareFileTreeInput: (paths: string[]) => paths,
}));

vi.mock('@pierre/trees/react', () => ({
	FileTree: ({ className }: { className?: string }) => <div data-testid="mock-tree" className={className} />,
	useFileTree: mocks.useFileTree,
	useFileTreeSearch: () => mocks.onSelectionChangeValues,
}));

import { TooltipProvider } from '@/components/ui/tooltip';

import { FileTree } from './file-tree';

import type { FileInfo } from '@shared/types';

const FINE_POINTER_MEDIA_QUERY = '(hover: hover) and (pointer: fine)';
const originalMatchMedia = globalThis.matchMedia;
let hasFinePointer = true;

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

function getUseFileTreeOptions(): MockUseFileTreeOptions {
	expect(mocks.useFileTree).toHaveBeenCalled();
	const firstCall = mocks.useFileTree.mock.calls[0];
	if (!firstCall) {
		throw new Error('Expected useFileTree to be called');
	}
	const [options] = firstCall;
	return options;
}

beforeEach(() => {
	hasFinePointer = true;
	vi.clearAllMocks();
	Object.defineProperty(globalThis, 'matchMedia', {
		configurable: true,
		writable: true,
		value: vi.fn((query: string) => ({
			matches: query === FINE_POINTER_MEDIA_QUERY ? hasFinePointer : false,
			media: query,
			onchange: undefined,
			addEventListener: vi.fn(),
			removeEventListener: vi.fn(),
			addListener: vi.fn(),
			removeListener: vi.fn(),
			dispatchEvent: vi.fn(() => false),
		})),
	});
});

afterEach(() => {
	Object.defineProperty(globalThis, 'matchMedia', {
		configurable: true,
		writable: true,
		value: originalMatchMedia,
	});
});

describe('FileTree sync', () => {
	it('uses always-visible context menu buttons without a fine pointer', () => {
		hasFinePointer = false;

		renderWithProviders(
			<FileTree files={[]} selectedFile={undefined} expandedDirectories={new Set()} onFileSelect={vi.fn()} onDirectoryToggle={vi.fn()} />,
		);

		const options = getUseFileTreeOptions();
		expect(options.composition?.contextMenu?.buttonVisibility).toBe('always');
	});

	it('uses when-needed context menu buttons with a fine pointer', () => {
		renderWithProviders(
			<FileTree files={[]} selectedFile={undefined} expandedDirectories={new Set()} onFileSelect={vi.fn()} onDirectoryToggle={vi.fn()} />,
		);

		const options = getUseFileTreeOptions();
		expect(options.composition?.contextMenu?.buttonVisibility).toBe('when-needed');
	});

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

	it('opens the file on a plain selection change', () => {
		const onFileSelect = vi.fn();
		renderWithProviders(
			<FileTree
				files={[]}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={onFileSelect}
				onDirectoryToggle={vi.fn()}
				onMoveFile={vi.fn()}
			/>,
		);

		const options = getUseFileTreeOptions();
		options.onSelectionChange?.(['src/main.tsx']);

		expect(onFileSelect).toHaveBeenCalledWith('/src/main.tsx');
	});

	it('does not open the file when the selection change comes from a drag pickup', () => {
		const onFileSelect = vi.fn();
		renderWithProviders(
			<FileTree
				files={[]}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={onFileSelect}
				onDirectoryToggle={vi.fn()}
				onMoveFile={vi.fn()}
			/>,
		);

		const options = getUseFileTreeOptions();
		expect(options.dragAndDrop?.canDrag?.(['src/main.tsx'])).toBe(true);
		options.onSelectionChange?.(['src/main.tsx']);

		expect(onFileSelect).not.toHaveBeenCalled();

		// The suppression is one-shot: the next plain selection opens normally.
		options.onSelectionChange?.(['src/other.tsx']);
		expect(onFileSelect).toHaveBeenCalledExactlyOnceWith('/src/other.tsx');
	});

	it('restores the model selection to the open file after a drag pickup', async () => {
		const deselect = vi.fn();
		const select = vi.fn();
		// The model has the dragged row selected after pickup; the open file is
		// '/src/open.tsx'.
		mocks.getSelectedPaths.mockReturnValue(['src/dragged.tsx']);
		mocks.getItem.mockImplementation((path: string) => ({
			deselect: path === 'src/dragged.tsx' ? deselect : vi.fn(),
			select: path === 'src/open.tsx' ? select : vi.fn(),
		}));

		renderWithProviders(
			<FileTree
				files={[]}
				selectedFile="/src/open.tsx"
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onMoveFile={vi.fn()}
			/>,
		);

		// Ignore the initial mount sync; only assert on the post-drag restore.
		deselect.mockClear();
		select.mockClear();

		const options = getUseFileTreeOptions();
		options.dragAndDrop?.canDrag?.(['src/dragged.tsx']);
		options.onSelectionChange?.(['src/dragged.tsx']);

		await Promise.resolve();

		expect(deselect).toHaveBeenCalledTimes(1);
		expect(select).toHaveBeenCalledTimes(1);
	});

	it('vibrates on drag pickup only on touch devices', () => {
		const vibrate = vi.fn();
		Object.defineProperty(globalThis.navigator, 'vibrate', { configurable: true, writable: true, value: vibrate });

		hasFinePointer = false;
		const { unmount } = renderWithProviders(
			<FileTree
				files={[]}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onMoveFile={vi.fn()}
			/>,
		);

		getUseFileTreeOptions().dragAndDrop?.canDrag?.(['src/main.tsx']);
		expect(vibrate).toHaveBeenCalledWith(15);

		unmount();
		vibrate.mockClear();
		mocks.useFileTree.mockClear();

		hasFinePointer = true;
		renderWithProviders(
			<FileTree
				files={[]}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onMoveFile={vi.fn()}
			/>,
		);

		getUseFileTreeOptions().dragAndDrop?.canDrag?.(['src/main.tsx']);
		expect(vibrate).not.toHaveBeenCalled();
	});
});
