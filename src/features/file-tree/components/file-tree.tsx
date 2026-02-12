/**
 * File Tree Component
 *
 * Hierarchical file explorer with expand/collapse support.
 */

import { ChevronDown, ChevronRight, File, Folder, FolderOpen } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useMemo } from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface FileTreeItem {
	name: string;
	path: string;
	isDirectory: boolean;
	children?: FileTreeItem[];
}

export interface FileTreeProperties {
	/** List of file paths */
	files: string[];
	/** Currently selected file */
	selectedFile: string | undefined;
	/** Set of expanded directory paths */
	expandedDirectories: Set<string>;
	/** Called when a file is selected */
	onFileSelect: (path: string) => void;
	/** Called when a directory is toggled */
	onDirectoryToggle: (path: string) => void;
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Tree Building
// =============================================================================

interface TreeNode {
	name: string;
	path: string;
	isDirectory: boolean;
	children?: Record<string, TreeNode>;
}

/**
 * Build a hierarchical tree from flat file paths.
 */
function buildFileTree(files: string[]): FileTreeItem[] {
	const root: Record<string, TreeNode> = {};

	for (const filePath of files) {
		const parts = filePath.split('/').filter(Boolean);
		let currentLevel = root;
		let currentPath = '';

		for (let index = 0; index < parts.length; index++) {
			const part = parts[index];
			currentPath = currentPath ? `${currentPath}/${part}` : `/${part}`;
			const isLast = index === parts.length - 1;

			if (!currentLevel[part]) {
				currentLevel[part] = {
					name: part,
					path: currentPath,
					isDirectory: !isLast,
					children: isLast ? undefined : {},
				};
			}

			if (!isLast) {
				const children = currentLevel[part].children;
				if (children) {
					currentLevel = children;
				}
			}
		}
	}

	// Convert to array and sort
	function toArray(level: Record<string, TreeNode>): FileTreeItem[] {
		return Object.values(level)
			.map((item) => ({
				name: item.name,
				path: item.path,
				isDirectory: item.isDirectory,
				children: item.children ? toArray(item.children) : undefined,
			}))
			.toSorted((a, b) => {
				// Directories first, then alphabetical
				if (a.isDirectory && !b.isDirectory) return -1;
				if (!a.isDirectory && b.isDirectory) return 1;
				return a.name.localeCompare(b.name);
			});
	}

	return toArray(root);
}

// =============================================================================
// Component
// =============================================================================

/**
 * File tree component for the sidebar.
 */
export function FileTree({ files, selectedFile, expandedDirectories, onFileSelect, onDirectoryToggle, className }: FileTreeProperties) {
	const tree = useMemo(() => buildFileTree(files), [files]);

	return (
		<ScrollArea.Root className={cn('h-full overflow-hidden', className)}>
			<ScrollArea.Viewport className="size-full">
				<div className="p-2">
					{tree.map((item) => (
						<FileTreeNode
							key={item.path}
							item={item}
							depth={0}
							selectedFile={selectedFile}
							expandedDirectories={expandedDirectories}
							onFileSelect={onFileSelect}
							onDirectoryToggle={onDirectoryToggle}
						/>
					))}
				</div>
			</ScrollArea.Viewport>
			<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
				<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
			</ScrollArea.Scrollbar>
		</ScrollArea.Root>
	);
}

// =============================================================================
// Tree Node Component
// =============================================================================

interface FileTreeNodeProperties {
	item: FileTreeItem;
	depth: number;
	selectedFile: string | undefined;
	expandedDirectories: Set<string>;
	onFileSelect: (path: string) => void;
	onDirectoryToggle: (path: string) => void;
}

function FileTreeNode({ item, depth, selectedFile, expandedDirectories, onFileSelect, onDirectoryToggle }: FileTreeNodeProperties) {
	const isExpanded = expandedDirectories.has(item.path);
	const isSelected = selectedFile === item.path;
	const paddingLeft = `${depth * 12 + 4}px`;

	const handleClick = () => {
		if (item.isDirectory) {
			onDirectoryToggle(item.path);
		} else {
			onFileSelect(item.path);
		}
	};

	const handleKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClick();
		}
	};

	return (
		<div>
			<div
				role="treeitem"
				tabIndex={0}
				aria-selected={isSelected}
				aria-expanded={item.isDirectory ? isExpanded : undefined}
				onClick={handleClick}
				onKeyDown={handleKeyDown}
				style={{ paddingLeft }}
				className={cn(
					`
						group flex cursor-pointer items-center gap-1 rounded-sm px-1 py-0.5
						text-sm
					`,
					`
						hover:bg-bg-tertiary
						focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none
					`,
					isSelected && 'bg-bg-tertiary text-text-primary',
					!isSelected && 'text-text-secondary',
				)}
			>
				{item.isDirectory ? (
					<>
						<span className="flex size-4 items-center justify-center text-text-secondary">
							{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
						</span>
						{isExpanded ? <FolderOpen className="size-4 text-accent" /> : <Folder className="size-4 text-accent" />}
					</>
				) : (
					<>
						<span className="size-4" />
						<FileIcon filename={item.name} />
					</>
				)}
				<span className="truncate">{item.name}</span>
			</div>
			{item.isDirectory && isExpanded && item.children && (
				<div role="group">
					{item.children.map((child) => (
						<FileTreeNode
							key={child.path}
							item={child}
							depth={depth + 1}
							selectedFile={selectedFile}
							expandedDirectories={expandedDirectories}
							onFileSelect={onFileSelect}
							onDirectoryToggle={onDirectoryToggle}
						/>
					))}
				</div>
			)}
		</div>
	);
}

// =============================================================================
// File Icon Component
// =============================================================================

function getFileColor(extension: string | undefined): string {
	switch (extension) {
		case 'ts':
		case 'tsx': {
			return 'text-blue-400';
		}
		case 'js':
		case 'jsx': {
			return 'text-yellow-400';
		}
		case 'css': {
			return 'text-purple-400';
		}
		case 'html': {
			return 'text-orange-400';
		}
		case 'json': {
			return 'text-green-400';
		}
		case 'md': {
			return 'text-gray-400';
		}
		default: {
			return 'text-text-secondary';
		}
	}
}

function FileIcon({ filename }: { filename: string }) {
	const extension = filename.split('.').pop()?.toLowerCase();

	return <File className={cn('size-4', getFileColor(extension))} />;
}
