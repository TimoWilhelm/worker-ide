/**
 * Component tests for FileTree.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileTree } from './file-tree';

const SAMPLE_FILES = ['/src/main.ts', '/src/app.tsx', '/src/lib/utils.ts', '/styles/index.css', '/index.html'];

describe('FileTree', () => {
	it('renders file tree from flat paths', () => {
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src', '/src/lib', '/styles'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		// Directories should be visible
		expect(screen.getByText('src')).toBeInTheDocument();
		expect(screen.getByText('styles')).toBeInTheDocument();

		// Files should be visible when parent is expanded
		expect(screen.getByText('main.ts')).toBeInTheDocument();
		expect(screen.getByText('app.tsx')).toBeInTheDocument();
		expect(screen.getByText('utils.ts')).toBeInTheDocument();
		expect(screen.getByText('index.css')).toBeInTheDocument();
		expect(screen.getByText('index.html')).toBeInTheDocument();
	});

	it('hides children when directory is collapsed', () => {
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()} // all collapsed
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		// Directories should still be visible at root level
		expect(screen.getByText('src')).toBeInTheDocument();
		expect(screen.getByText('styles')).toBeInTheDocument();
		expect(screen.getByText('index.html')).toBeInTheDocument();

		// Files inside collapsed dirs should not be visible
		expect(screen.queryByText('main.ts')).not.toBeInTheDocument();
		expect(screen.queryByText('app.tsx')).not.toBeInTheDocument();
	});

	it('calls onFileSelect when a file is clicked', () => {
		const onFileSelect = vi.fn();
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={onFileSelect}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		fireEvent.click(screen.getByText('main.ts'));
		expect(onFileSelect).toHaveBeenCalledWith('/src/main.ts');
	});

	it('calls onDirectoryToggle when a directory is clicked', () => {
		const onDirectoryToggle = vi.fn();
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={onDirectoryToggle}
			/>,
		);

		fireEvent.click(screen.getByText('src'));
		expect(onDirectoryToggle).toHaveBeenCalledWith('/src');
	});

	it('highlights the selected file', () => {
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile="/src/main.ts"
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItem = screen.getByText('main.ts').closest('[role="treeitem"]');
		expect(treeItem).toHaveAttribute('aria-selected', 'true');
	});

	it('sorts directories before files', () => {
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItems = screen.getAllByRole('treeitem');
		const labels = treeItems.map((item) => item.textContent);

		// src and styles dirs should come before index.html
		const sourceIndex = labels.findIndex((label) => label?.includes('src'));
		const stylesIndex = labels.findIndex((label) => label?.includes('styles'));
		const htmlIndex = labels.findIndex((label) => label?.includes('index.html'));

		expect(sourceIndex).toBeLessThan(htmlIndex);
		expect(stylesIndex).toBeLessThan(htmlIndex);
	});

	it('supports keyboard navigation with Enter', () => {
		const onFileSelect = vi.fn();
		render(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={onFileSelect}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItem = screen.getByText('main.ts').closest('[role="treeitem"]')!;
		fireEvent.keyDown(treeItem, { key: 'Enter' });
		expect(onFileSelect).toHaveBeenCalledWith('/src/main.ts');
	});

	it('renders empty tree for empty files list', () => {
		const { container } = render(
			<FileTree files={[]} selectedFile={undefined} expandedDirectories={new Set()} onFileSelect={vi.fn()} onDirectoryToggle={vi.fn()} />,
		);

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
	});
});
