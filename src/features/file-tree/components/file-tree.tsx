/**
 * File Tree Component
 *
 * Hierarchical file explorer with expand/collapse support.
 */

import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderOpen, Pencil, Trash2 } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PROTECTED_FILES } from '@shared/constants';

import type { Participant } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

export interface FileTreeItem {
	name: string;
	path: string;
	isDirectory: boolean;
	children?: FileTreeItem[];
}

function buildVisibleNodes(items: FileTreeItem[], expandedDirectories: Set<string>, depth = 0, parentPath?: string): VisibleTreeNode[] {
	const nodes: VisibleTreeNode[] = [];
	for (const item of items) {
		const isExpanded = item.isDirectory && expandedDirectories.has(item.path);
		nodes.push({
			path: item.path,
			name: item.name,
			isDirectory: item.isDirectory,
			depth,
			parentPath,
			isExpanded,
		});
		if (item.isDirectory && isExpanded && item.children) {
			nodes.push(...buildVisibleNodes(item.children, expandedDirectories, depth + 1, item.path));
		}
	}
	return nodes;
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
	/** Called when a file should be created */
	onCreateFile?: (path: string) => void;
	/** Called when a file should be deleted */
	onDeleteFile?: (path: string) => void;
	/** Called when a file should be renamed */
	onRenameFile?: (fromPath: string, toPath: string) => void;
	/** Connected collaborators for showing presence dots */
	participants?: Participant[];
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

interface VisibleTreeNode {
	path: string;
	name: string;
	isDirectory: boolean;
	depth: number;
	parentPath?: string;
	isExpanded: boolean;
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
export function FileTree({
	files,
	selectedFile,
	expandedDirectories,
	onFileSelect,
	onDirectoryToggle,
	onCreateFile,
	onDeleteFile,
	onRenameFile,
	participants = [],
	className,
}: FileTreeProperties) {
	const tree = useMemo(() => buildFileTree(files), [files]);
	const visibleNodes = useMemo(() => buildVisibleNodes(tree, expandedDirectories), [tree, expandedDirectories]);
	const firstVisiblePath = visibleNodes[0]?.path;
	const [focusedPath, setFocusedPath] = useState<string | undefined>(() => selectedFile ?? firstVisiblePath);
	const treeLabelId = useId();
	const nodeReferences = useRef<Map<string, HTMLDivElement>>(new Map());
	const visibleNodeIndex = useMemo(() => new Map(visibleNodes.map((node, index) => [node.path, { index, node }])), [visibleNodes]);
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [newFilePath, setNewFilePath] = useState('');
	const [deleteTarget, setDeleteTarget] = useState<string | undefined>();
	const [renamingPath, setRenamingPath] = useState<string | undefined>();
	const activeFocusPath =
		(focusedPath && visibleNodeIndex.has(focusedPath) ? focusedPath : undefined) ??
		(selectedFile && visibleNodeIndex.has(selectedFile) ? selectedFile : firstVisiblePath);

	const handleCreateSubmit = useCallback(() => {
		const trimmed = newFilePath.trim();
		if (trimmed && onCreateFile) {
			const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
			onCreateFile(path);
		}
		setIsCreateModalOpen(false);
		setNewFilePath('');
	}, [newFilePath, onCreateFile]);

	const setNodeReference = useCallback((path: string, node: HTMLDivElement | null) => {
		if (node) {
			nodeReferences.current.set(path, node);
			return;
		}
		nodeReferences.current.delete(path);
	}, []);

	const focusNode = useCallback((path: string | undefined) => {
		if (!path) return;
		nodeReferences.current.get(path)?.focus();
	}, []);

	const handleNodeFocus = useCallback((path: string) => {
		setFocusedPath(path);
	}, []);

	const handleDeleteRequest = useCallback((path: string) => {
		setDeleteTarget(path);
	}, []);

	const handleTreeItemKeyDown = useCallback(
		(event: React.KeyboardEvent, path: string) => {
			const entry = visibleNodeIndex.get(path);
			if (!entry) return;
			const { index, node } = entry;
			const lastIndex = visibleNodes.length - 1;

			switch (event.key) {
				case 'ArrowDown': {
					const next = visibleNodes[index + 1];
					if (!next) return;
					event.preventDefault();
					setFocusedPath(next.path);
					focusNode(next.path);
					return;
				}
				case 'ArrowUp': {
					const previous = visibleNodes[index - 1];
					if (!previous) return;
					event.preventDefault();
					setFocusedPath(previous.path);
					focusNode(previous.path);
					return;
				}
				case 'ArrowRight': {
					if (!node.isDirectory) return;
					if (!node.isExpanded) {
						event.preventDefault();
						onDirectoryToggle(node.path);
						return;
					}
					const next = visibleNodes[index + 1];
					if (!next || next.parentPath !== node.path) return;
					event.preventDefault();
					setFocusedPath(next.path);
					focusNode(next.path);
					return;
				}
				case 'ArrowLeft': {
					if (node.isDirectory && node.isExpanded) {
						event.preventDefault();
						onDirectoryToggle(node.path);
						return;
					}
					if (!node.parentPath) return;
					event.preventDefault();
					setFocusedPath(node.parentPath);
					focusNode(node.parentPath);
					return;
				}
				case 'Home': {
					if (!visibleNodes[0]) return;
					event.preventDefault();
					setFocusedPath(visibleNodes[0].path);
					focusNode(visibleNodes[0].path);
					return;
				}
				case 'End': {
					if (lastIndex < 0) return;
					event.preventDefault();
					const lastNode = visibleNodes[lastIndex];
					setFocusedPath(lastNode.path);
					focusNode(lastNode.path);
					return;
				}
				case 'Enter':
				case ' ': {
					event.preventDefault();
					if (node.isDirectory) {
						onDirectoryToggle(node.path);
						return;
					}
					onFileSelect(node.path);
					return;
				}
				case 'F2': {
					if (!node.isDirectory && onRenameFile) {
						event.preventDefault();
						setRenamingPath(node.path);
					}
					return;
				}
				case 'Delete': {
					if (!node.isDirectory && onDeleteFile) {
						const isNodeProtected = PROTECTED_FILES.has(node.path);
						if (!isNodeProtected) {
							event.preventDefault();
							handleDeleteRequest(node.path);
						}
					}
					return;
				}
				default: {
					return;
				}
			}
		},
		[focusNode, handleDeleteRequest, onDeleteFile, onDirectoryToggle, onFileSelect, onRenameFile, visibleNodeIndex, visibleNodes],
	);

	const handleOpenCreateModal = useCallback((prefillPath?: string) => {
		setNewFilePath(prefillPath ?? '');
		setIsCreateModalOpen(true);
	}, []);

	const handleDeleteConfirm = useCallback(() => {
		if (deleteTarget && onDeleteFile) {
			onDeleteFile(deleteTarget);
		}
		setDeleteTarget(undefined);
	}, [deleteTarget, onDeleteFile]);

	return (
		<>
			<div className={cn('flex h-full flex-col', className)}>
				{/* Files header */}
				<div className="flex items-center justify-between px-3 pt-1.5 pb-0.5">
					<span
						id={treeLabelId}
						className="
							text-xs font-semibold tracking-wider text-text-secondary uppercase
						"
					>
						Files
					</span>
					{onCreateFile && (
						<Tooltip content="New file">
							<button
								onClick={() => handleOpenCreateModal()}
								className={cn(
									`
										flex size-6 cursor-pointer items-center justify-center rounded-sm
										text-text-secondary
									`,
									`
										transition-colors
										hover:bg-bg-tertiary hover:text-text-primary
									`,
								)}
								aria-label="New file"
							>
								<FilePlus className="size-3.5" />
							</button>
						</Tooltip>
					)}
				</div>

				{/* File tree */}
				<ScrollArea.Root className="flex-1 overflow-hidden">
					<ScrollArea.Viewport className="size-full">
						<div role="tree" aria-labelledby={treeLabelId} className="py-1">
							{tree.map((item) => (
								<FileTreeNode
									key={item.path}
									item={item}
									depth={0}
									selectedFile={selectedFile}
									expandedDirectories={expandedDirectories}
									onFileSelect={onFileSelect}
									onDirectoryToggle={onDirectoryToggle}
									onDeleteFile={onDeleteFile ? handleDeleteRequest : undefined}
									onCreateFileInDirectory={onCreateFile ? handleOpenCreateModal : undefined}
									onRenameFile={onRenameFile}
									renamingPath={renamingPath}
									onStartRename={setRenamingPath}
									onCancelRename={() => setRenamingPath(undefined)}
									participants={participants}
									activeFocusPath={activeFocusPath}
									onNodeFocus={handleNodeFocus}
									onNodeKeyDown={handleTreeItemKeyDown}
									setNodeReference={setNodeReference}
								/>
							))}
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>
			</div>

			{/* New File Modal */}
			<Modal open={isCreateModalOpen} onOpenChange={setIsCreateModalOpen} title="New File">
				<ModalBody>
					<input
						autoFocus
						type="text"
						value={newFilePath}
						onChange={(event) => setNewFilePath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter') handleCreateSubmit();
						}}
						placeholder="Enter file path (e.g. /src/utils.js)"
						className={cn(
							`w-full rounded-md border border-border bg-bg-primary px-3 py-2 text-sm`,
							`
								text-text-primary
								placeholder:text-text-secondary
							`,
							`focus:border-accent focus:outline-none`,
						)}
					/>
				</ModalBody>
				<ModalFooter>
					<Button variant="secondary" size="sm" onClick={() => setIsCreateModalOpen(false)}>
						Cancel
					</Button>
					<Button variant="default" size="sm" onClick={handleCreateSubmit} disabled={!newFilePath.trim()}>
						Create
					</Button>
				</ModalFooter>
			</Modal>

			{/* Delete Confirmation Dialog */}
			<ConfirmDialog
				open={deleteTarget !== undefined}
				onOpenChange={(open) => {
					if (!open) setDeleteTarget(undefined);
				}}
				title="Delete File"
				description={
					<>
						Are you sure you want to delete <strong className="text-text-primary">{deleteTarget}</strong>? This action cannot be undone.
					</>
				}
				confirmLabel="Delete"
				cancelLabel="Cancel"
				variant="danger"
				onConfirm={handleDeleteConfirm}
			/>
		</>
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
	onDeleteFile?: (path: string) => void;
	onCreateFileInDirectory?: (prefillPath: string) => void;
	onRenameFile?: (fromPath: string, toPath: string) => void;
	renamingPath: string | undefined;
	onStartRename: (path: string) => void;
	onCancelRename: () => void;
	participants: Participant[];
	activeFocusPath: string | undefined;
	onNodeFocus: (path: string) => void;
	onNodeKeyDown: (event: React.KeyboardEvent, path: string) => void;
	setNodeReference: (path: string, node: HTMLDivElement | null) => void;
}

function FileTreeNode({
	item,
	depth,
	selectedFile,
	expandedDirectories,
	onFileSelect,
	onDirectoryToggle,
	onDeleteFile,
	onCreateFileInDirectory,
	onRenameFile,
	renamingPath,
	onStartRename,
	onCancelRename,
	participants,
	activeFocusPath,
	onNodeFocus,
	onNodeKeyDown,
	setNodeReference,
}: FileTreeNodeProperties) {
	const isExpanded = expandedDirectories.has(item.path);
	const isSelected = selectedFile === item.path;
	const isProtected = !item.isDirectory && PROTECTED_FILES.has(item.path);
	const paddingLeft = `${depth * 12 + 12}px`;
	const fileParticipants = item.isDirectory ? [] : participants.filter((participant) => participant.file === item.path);
	const tabIndex = item.path === activeFocusPath ? 0 : -1;
	const isRenaming = renamingPath === item.path;
	const renameInputReference = useRef<HTMLInputElement>(null);

	const handleRenameSubmit = useCallback(
		(newName: string) => {
			const trimmed = newName.trim();
			if (trimmed && trimmed !== item.name && onRenameFile) {
				const directory = item.path.slice(0, item.path.lastIndexOf('/'));
				const newPath = `${directory}/${trimmed}`;
				onRenameFile(item.path, newPath);
			}
			onCancelRename();
		},
		[item.name, item.path, onRenameFile, onCancelRename],
	);

	const handleDoubleClick = useCallback(
		(event: React.MouseEvent) => {
			if (!item.isDirectory && !isProtected && onRenameFile) {
				event.stopPropagation();
				onStartRename(item.path);
			}
		},
		[item.isDirectory, item.path, isProtected, onRenameFile, onStartRename],
	);

	const handleClick = () => {
		if (item.isDirectory) {
			onDirectoryToggle(item.path);
		} else {
			onFileSelect(item.path);
		}
	};

	const handleDelete = (event: React.MouseEvent) => {
		event.stopPropagation();
		if (onDeleteFile && !isProtected) {
			onDeleteFile(item.path);
		}
	};

	const handleCreateInFolder = (event: React.MouseEvent) => {
		event.stopPropagation();
		if (onCreateFileInDirectory) {
			onCreateFileInDirectory(`${item.path}/`);
		}
	};

	const handleStartRename = (event: React.MouseEvent) => {
		event.stopPropagation();
		if (!isProtected && onRenameFile) {
			onStartRename(item.path);
		}
	};

	return (
		<div>
			<div
				role="treeitem"
				tabIndex={tabIndex}
				aria-selected={isSelected}
				aria-expanded={item.isDirectory ? isExpanded : undefined}
				aria-level={depth + 1}
				onClick={handleClick}
				onKeyDown={(event) => onNodeKeyDown(event, item.path)}
				onFocus={() => onNodeFocus(item.path)}
				ref={(node) => setNodeReference(item.path, node)}
				style={{ paddingLeft }}
				className={cn(
					`
						group flex cursor-pointer items-center gap-1.5 py-1 pr-2 text-sm
						select-none
					`,
					`
						hover:bg-bg-tertiary
						focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none
					`,
					isSelected && 'bg-accent/15 text-accent',
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
				{isRenaming ? (
					<input
						ref={renameInputReference}
						autoFocus
						type="text"
						defaultValue={item.name}
						onBlur={(event) => handleRenameSubmit(event.target.value)}
						onKeyDown={(event) => {
							event.stopPropagation();
							if (event.key === 'Enter') {
								handleRenameSubmit(event.currentTarget.value);
							}
							if (event.key === 'Escape') {
								onCancelRename();
							}
						}}
						onClick={(event) => event.stopPropagation()}
						className={cn('flex-1 rounded-sm border border-accent bg-bg-primary px-1 text-sm', 'text-text-primary outline-none')}
						aria-label={`Rename ${item.name}`}
					/>
				) : (
					<Tooltip content={item.path}>
						<span className="flex-1 truncate" onDoubleClick={handleDoubleClick}>
							{item.name}
						</span>
					</Tooltip>
				)}
				{/* Collaborator presence dots — always visible, positioned before hover buttons */}
				{fileParticipants.length > 0 && (
					<div className="flex shrink-0 items-center gap-0.5">
						{fileParticipants.slice(0, 3).map((participant) => (
							<span key={participant.id} className="size-1.5 rounded-full" style={{ backgroundColor: participant.color }} />
						))}
						{fileParticipants.length > 3 && <span className="text-3xs text-text-secondary">+{fileParticipants.length - 3}</span>}
					</div>
				)}
				{item.isDirectory && onCreateFileInDirectory && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleCreateInFolder}
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary opacity-0 transition-colors
							hover-always:text-accent
							group-hover-always:opacity-100
						"
						aria-label={`New file in ${item.name}`}
					>
						<FilePlus className="size-3" />
					</button>
				)}
				{!item.isDirectory && !isProtected && onRenameFile && !isRenaming && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleStartRename}
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary opacity-0 transition-colors
							hover-always:text-accent
							group-hover-always:opacity-100
						"
						aria-label={`Rename ${item.name}`}
					>
						<Pencil className="size-3" />
					</button>
				)}
				{!item.isDirectory && !isProtected && onDeleteFile && !isRenaming && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleDelete}
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary opacity-0 transition-colors
							hover-always:text-error
							group-hover-always:opacity-100
						"
						aria-label={`Delete ${item.name}`}
					>
						<Trash2 className="size-3" />
					</button>
				)}
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
							onDeleteFile={onDeleteFile}
							onCreateFileInDirectory={onCreateFileInDirectory}
							onRenameFile={onRenameFile}
							renamingPath={renamingPath}
							onStartRename={onStartRename}
							onCancelRename={onCancelRename}
							participants={participants}
							activeFocusPath={activeFocusPath}
							onNodeFocus={onNodeFocus}
							onNodeKeyDown={onNodeKeyDown}
							setNodeReference={setNodeReference}
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
			return 'text-blue-600 dark:text-blue-400';
		}
		case 'js':
		case 'jsx': {
			return 'text-yellow-600 dark:text-yellow-400';
		}
		case 'css': {
			return 'text-purple-600 dark:text-purple-400';
		}
		case 'html': {
			return 'text-orange-600 dark:text-orange-400';
		}
		case 'json': {
			return 'text-green-600 dark:text-green-400';
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
