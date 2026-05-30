import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { FileTree } from './file-tree';

import type { FileInfo } from '@shared/types';

function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const SAMPLE_FILES: FileInfo[] = [
	{ path: '/src/main.ts', name: 'main.ts', isDirectory: false },
	{ path: '/src/app.tsx', name: 'app.tsx', isDirectory: false },
	{ path: '/src/lib/utils.ts', name: 'utils.ts', isDirectory: false },
	{ path: '/styles/index.css', name: 'index.css', isDirectory: false },
	{ path: '/index.html', name: 'index.html', isDirectory: false },
	{ path: '/docs', name: 'docs', isDirectory: true },
];

describe('FileTree', () => {
	it('renders the panel header', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		expect(screen.getByText('Files')).toBeInTheDocument();
	});

	it('mounts the @pierre/trees host element', () => {
		const { container } = renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		// The React wrapper mounts the tree into a custom element host.
		expect(container.querySelector('file-tree-container')).toBeInTheDocument();
	});

	it('renders create buttons only when their callbacks are provided', () => {
		const { rerender } = renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		expect(screen.queryByLabelText('New file')).not.toBeInTheDocument();
		expect(screen.queryByLabelText('New folder')).not.toBeInTheDocument();

		rerender(
			<TooltipProvider>
				<FileTree
					files={SAMPLE_FILES}
					selectedFile={undefined}
					expandedDirectories={new Set()}
					onFileSelect={vi.fn()}
					onDirectoryToggle={vi.fn()}
					onCreateFile={vi.fn()}
					onCreateFolder={vi.fn()}
				/>
			</TooltipProvider>,
		);

		expect(screen.getByLabelText('New file')).toBeInTheDocument();
		expect(screen.getByLabelText('New folder')).toBeInTheDocument();
	});

	it('toggles the search field via the search button', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		expect(screen.queryByPlaceholderText('Search files')).not.toBeInTheDocument();

		fireEvent.click(screen.getByLabelText('Search files'));
		expect(screen.getByPlaceholderText('Search files')).toBeInTheDocument();

		fireEvent.click(screen.getByLabelText('Close search'));
		expect(screen.queryByPlaceholderText('Search files')).not.toBeInTheDocument();
	});

	it('prompts and forwards a leading-slash path to onCreateFile', () => {
		const onCreateFile = vi.fn();
		const promptSpy = vi.spyOn(globalThis, 'prompt').mockReturnValue('new-file.ts');

		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onCreateFile={onCreateFile}
			/>,
		);

		fireEvent.click(screen.getByLabelText('New file'));
		expect(onCreateFile).toHaveBeenCalledTimes(1);
		expect(onCreateFile.mock.calls[0][0]).toMatch(/^\/.*new-file\.ts$/);

		promptSpy.mockRestore();
	});

	it('does not create a file when the prompt is empty', () => {
		const onCreateFile = vi.fn();
		const promptSpy = vi.spyOn(globalThis, 'prompt').mockReturnValue('   ');

		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onCreateFile={onCreateFile}
			/>,
		);

		fireEvent.click(screen.getByLabelText('New file'));
		expect(onCreateFile).not.toHaveBeenCalled();

		promptSpy.mockRestore();
	});

	it('renders without crashing for an empty file list', () => {
		const { container } = renderWithProviders(
			<FileTree files={[]} selectedFile={undefined} expandedDirectories={new Set()} onFileSelect={vi.fn()} onDirectoryToggle={vi.fn()} />,
		);

		expect(container.querySelector('file-tree-container')).toBeInTheDocument();
	});
});
