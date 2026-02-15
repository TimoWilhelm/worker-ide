/**
 * Component tests for FileTree.
 */

import { render, screen, fireEvent } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';

import { FileTree } from './file-tree';

import type { FileInfo } from '@shared/types';

/**
 * Helper to wrap component in required providers.
 */
function renderWithProviders(ui: React.ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>);
}

const SAMPLE_FILES: FileInfo[] = [
	{ path: '/src/main.ts', name: 'main.ts', isDirectory: false },
	{ path: '/src/app.tsx', name: 'app.tsx', isDirectory: false },
	{ path: '/src/lib/utils.ts', name: 'utils.ts', isDirectory: false },
	{ path: '/styles/index.css', name: 'index.css', isDirectory: false },
	{ path: '/index.html', name: 'index.html', isDirectory: false },
	{ path: '/docs', name: 'docs', isDirectory: true }, // Empty directory
];

describe('FileTree', () => {
	it('renders file tree from flat paths', () => {
		renderWithProviders(
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
		expect(screen.getByText('docs')).toBeInTheDocument();

		// Files should be visible when parent is expanded
		expect(screen.getByText('main.ts')).toBeInTheDocument();
		expect(screen.getByText('app.tsx')).toBeInTheDocument();
		expect(screen.getByText('utils.ts')).toBeInTheDocument();
		expect(screen.getByText('index.css')).toBeInTheDocument();
		expect(screen.getByText('index.html')).toBeInTheDocument();
	});

	it('hides children when directory is collapsed', () => {
		renderWithProviders(
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
		renderWithProviders(
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
		renderWithProviders(
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
		renderWithProviders(
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
		renderWithProviders(
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
		renderWithProviders(
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
		const { container } = renderWithProviders(
			<FileTree files={[]} selectedFile={undefined} expandedDirectories={new Set()} onFileSelect={vi.fn()} onDirectoryToggle={vi.fn()} />,
		);

		expect(container.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
	});

	it('has a role="tree" container', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		expect(screen.getByRole('tree')).toBeInTheDocument();
	});

	it('uses roving tabindex — only one treeitem has tabIndex 0', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src', '/styles'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItems = screen.getAllByRole('treeitem');
		const focusableItems = treeItems.filter((item) => item.tabIndex === 0);
		expect(focusableItems).toHaveLength(1);

		const nonFocusableItems = treeItems.filter((item) => item.tabIndex === -1);
		expect(nonFocusableItems.length).toBe(treeItems.length - 1);
	});

	it('sets aria-level on treeitems', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const sourceDirectory = screen.getByText('src').closest('[role="treeitem"]');
		expect(sourceDirectory).toHaveAttribute('aria-level', '1');

		const mainFile = screen.getByText('main.ts').closest('[role="treeitem"]');
		expect(mainFile).toHaveAttribute('aria-level', '2');
	});

	it('navigates with ArrowDown and ArrowUp keys', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItems = screen.getAllByRole('treeitem');
		const firstItem = treeItems[0];
		firstItem.focus();

		fireEvent.keyDown(firstItem, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(treeItems[1]);

		fireEvent.keyDown(treeItems[1], { key: 'ArrowUp' });
		expect(document.activeElement).toBe(firstItem);
	});

	it('expands a collapsed directory with ArrowRight', () => {
		const onDirectoryToggle = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={onDirectoryToggle}
			/>,
		);

		const sourceItem = screen.getByText('src').closest<HTMLElement>('[role="treeitem"]')!;
		sourceItem.focus();
		fireEvent.keyDown(sourceItem, { key: 'ArrowRight' });
		expect(onDirectoryToggle).toHaveBeenCalledWith('/src');
	});

	it('collapses an expanded directory with ArrowLeft', () => {
		const onDirectoryToggle = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={onDirectoryToggle}
			/>,
		);

		const sourceItem = screen.getByText('src').closest<HTMLElement>('[role="treeitem"]')!;
		sourceItem.focus();
		fireEvent.keyDown(sourceItem, { key: 'ArrowLeft' });
		expect(onDirectoryToggle).toHaveBeenCalledWith('/src');
	});

	it('exposes aria-expanded on directories', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const expandedDirectory = screen.getByText('src').closest('[role="treeitem"]');
		expect(expandedDirectory).toHaveAttribute('aria-expanded', 'true');

		const collapsedDirectory = screen.getByText('styles').closest('[role="treeitem"]');
		expect(collapsedDirectory).toHaveAttribute('aria-expanded', 'false');

		const fileItem = screen.getByText('main.ts').closest('[role="treeitem"]');
		expect(fileItem).not.toHaveAttribute('aria-expanded');
	});

	it('toggles directory with Space key', () => {
		const onDirectoryToggle = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={onDirectoryToggle}
			/>,
		);

		const sourceItem = screen.getByText('src').closest<HTMLElement>('[role="treeitem"]')!;
		sourceItem.focus();
		fireEvent.keyDown(sourceItem, { key: ' ' });
		expect(onDirectoryToggle).toHaveBeenCalledWith('/src');
	});

	it('selects a file with Space key', () => {
		const onFileSelect = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={onFileSelect}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const fileItem = screen.getByText('main.ts').closest<HTMLElement>('[role="treeitem"]')!;
		fileItem.focus();
		fireEvent.keyDown(fileItem, { key: ' ' });
		expect(onFileSelect).toHaveBeenCalledWith('/src/main.ts');
	});

	it('ArrowLeft on a child node moves focus to parent directory', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const childItem = screen.getByText('main.ts').closest<HTMLElement>('[role="treeitem"]')!;
		childItem.focus();
		fireEvent.keyDown(childItem, { key: 'ArrowLeft' });

		const parentItem = screen.getByText('src').closest<HTMLElement>('[role="treeitem"]')!;
		expect(document.activeElement).toBe(parentItem);
	});

	it('triggers delete confirmation with Delete key on a non-protected file', () => {
		const onDeleteFile = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onDeleteFile={onDeleteFile}
			/>,
		);

		const fileItem = screen.getByText('main.ts').closest<HTMLElement>('[role="treeitem"]')!;
		fileItem.focus();
		fireEvent.keyDown(fileItem, { key: 'Delete' });

		// Should open the confirmation dialog
		expect(screen.getByText('Delete Item')).toBeInTheDocument();
	});

	it('enters rename mode with F2 key on a non-protected file', () => {
		const onRenameFile = vi.fn();
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onRenameFile={onRenameFile}
			/>,
		);

		const fileItem = screen.getByText('main.ts').closest<HTMLElement>('[role="treeitem"]')!;
		fileItem.focus();
		fireEvent.keyDown(fileItem, { key: 'F2' });

		// Should show a rename input
		expect(screen.getByLabelText('Rename main.ts')).toBeInTheDocument();
	});

	it('action buttons are not in the tab order', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set(['/src'])}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
				onDeleteFile={vi.fn()}
				onRenameFile={vi.fn()}
			/>,
		);

		const deleteButton = screen.getByLabelText('Delete main.ts');
		expect(deleteButton).toHaveAttribute('tabindex', '-1');

		const renameButton = screen.getByLabelText('Rename main.ts');
		expect(renameButton).toHaveAttribute('tabindex', '-1');
	});

	it('navigates to first and last items with Home and End', () => {
		renderWithProviders(
			<FileTree
				files={SAMPLE_FILES}
				selectedFile={undefined}
				expandedDirectories={new Set()}
				onFileSelect={vi.fn()}
				onDirectoryToggle={vi.fn()}
			/>,
		);

		const treeItems = screen.getAllByRole('treeitem');
		const lastItem = treeItems.at(-1)!;
		const firstItem = treeItems[0];

		firstItem.focus();
		fireEvent.keyDown(firstItem, { key: 'End' });
		expect(document.activeElement).toBe(lastItem);

		fireEvent.keyDown(lastItem, { key: 'Home' });
		expect(document.activeElement).toBe(firstItem);
	});
});
