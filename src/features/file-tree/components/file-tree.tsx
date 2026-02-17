/**
 * File Tree Component
 *
 * Hierarchical file explorer with expand/collapse support.
 */

import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderOpen, FolderPlus, Lock, Pencil, Trash2 } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useId, useMemo, useRef, useState } from 'react';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { PROTECTED_FILES } from '@shared/constants';

import type { FileInfo, GitFileStatus, Participant } from '@shared/types';

// =============================================================================
// Git Status Color
// =============================================================================

function getGitStatusColor(status: GitFileStatus | undefined): string | undefined {
	if (!status || status === 'unmodified') return undefined;

	switch (status) {
		case 'modified':
		case 'modified-staged':
		case 'modified-partially-staged': {
			return 'text-sky-400';
		}
		case 'untracked':
		case 'untracked-staged':
		case 'untracked-partially-staged': {
			return 'text-emerald-400';
		}
		case 'deleted':
		case 'deleted-staged': {
			return 'text-red-400';
		}
		default: {
			return undefined;
		}
	}
}

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
	files: FileInfo[];
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
	/** Called when a folder should be created */
	onCreateFolder?: (path: string) => void;
	/** Called when a file/folder should be moved via drag-and-drop */
	onMoveFile?: (fromPath: string, toPath: string) => void;
	/** Connected collaborators for showing presence dots */
	participants?: Participant[];
	/** Git status map: file path (without leading /) -> git status */
	gitStatusMap?: Map<string, GitFileStatus>;
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
 * Build a hierarchical tree from flat file info.
 */
function buildFileTree(files: FileInfo[]): FileTreeItem[] {
	const root: Record<string, TreeNode> = {};

	for (const file of files) {
		const parts = file.path.split('/').filter(Boolean);
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
					isDirectory: true, // Default to directory for intermediate nodes
					children: {},
				};
			}

			// If this is the actual file/folder verify its type
			if (isLast) {
				currentLevel[part].isDirectory = file.isDirectory;
				if (!file.isDirectory) {
					// It's a file, so it shouldn't have children unless we have a conflict (folder and file with same name?)
					// For now, let's just set children to undefined if it was just created.
					// But if we already created it as a directory (implicit), and now we see it's a file... that shouldn't happen with valid paths.
					// But if it's a directory, we leave children as {} (initialized above).
					// If it's a file, we can set children to undefined.
					currentLevel[part].children = undefined;
				}
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
	onCreateFolder,
	onMoveFile,
	participants = [],
	gitStatusMap,
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
	const [isCreateFolderModalOpen, setIsCreateFolderModalOpen] = useState(false);
	const [newFilePath, setNewFilePath] = useState('');
	const [newFolderPath, setNewFolderPath] = useState('');
	const [deleteTarget, setDeleteTarget] = useState<string | undefined>();
	const [renamingPath, setRenamingPath] = useState<string | undefined>();
	const [dragOverPath, setDragOverPath] = useState<string | undefined>();
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

	const handleCreateFolderSubmit = useCallback(() => {
		const trimmed = newFolderPath.trim();
		if (trimmed && onCreateFolder) {
			const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
			onCreateFolder(path);
		}
		setIsCreateFolderModalOpen(false);
		setNewFolderPath('');
	}, [newFolderPath, onCreateFolder]);

	const handleOpenCreateFolderModal = useCallback((prefillPath?: string) => {
		setNewFolderPath(prefillPath ?? '');
		setIsCreateFolderModalOpen(true);
	}, []);

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
					if (onDeleteFile) {
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
					<div className="flex items-center gap-0.5">
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
						{onCreateFolder && (
							<Tooltip content="New folder">
								<button
									onClick={() => handleOpenCreateFolderModal()}
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
									aria-label="New folder"
								>
									<FolderPlus className="size-3.5" />
								</button>
							</Tooltip>
						)}
					</div>
				</div>

				{/* File tree */}
				<ScrollArea.Root className="h-full flex-1 overflow-hidden">
					<ScrollArea.Viewport
						className="
							size-full
							[&>div]:block! [&>div]:h-full! [&>div]:min-w-0!
						"
					>
						<div
							role="tree"
							aria-labelledby={treeLabelId}
							className={cn(
								'min-h-full flex-1 overflow-hidden py-1',
								dragOverPath === '__root__' && 'bg-accent/5 ring-1 ring-accent ring-inset',
							)}
							onDragOver={
								onMoveFile
									? (event) => {
											// Only highlight root if the drag target is the tree itself
											const target = event.target;
											if (event.currentTarget === target || (target instanceof HTMLElement && target.getAttribute('role') === 'tree')) {
												event.preventDefault();
												event.dataTransfer.dropEffect = 'move';
												setDragOverPath('__root__');
											}
										}
									: undefined
							}
							onDragLeave={
								onMoveFile
									? (event) => {
											if (event.currentTarget === event.target) {
												setDragOverPath(undefined);
											}
										}
									: undefined
							}
							onDrop={
								onMoveFile
									? (event) => {
											event.preventDefault();
											setDragOverPath(undefined);
											const sourcePath = event.dataTransfer.getData('text/x-file-path');
											if (!sourcePath) return;
											const sourceName = sourcePath.split('/').pop()!;
											const newPath = `/${sourceName}`;
											if (newPath !== sourcePath) {
												onMoveFile(sourcePath, newPath);
											}
										}
									: undefined
							}
						>
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
									onCreateFolderInDirectory={onCreateFolder ? handleOpenCreateFolderModal : undefined}
									onRenameFile={onRenameFile}
									onMoveFile={onMoveFile}
									dragOverPath={dragOverPath}
									onDragOverPathChange={setDragOverPath}
									renamingPath={renamingPath}
									onStartRename={setRenamingPath}
									onCancelRename={() => setRenamingPath(undefined)}
									participants={participants}
									gitStatusMap={gitStatusMap}
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

			{/* New Folder Modal */}
			<Modal open={isCreateFolderModalOpen} onOpenChange={setIsCreateFolderModalOpen} title="New Folder">
				<ModalBody>
					<input
						autoFocus
						type="text"
						value={newFolderPath}
						onChange={(event) => setNewFolderPath(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === 'Enter') handleCreateFolderSubmit();
						}}
						placeholder="Enter folder path (e.g. /src/components)"
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
					<Button variant="secondary" size="sm" onClick={() => setIsCreateFolderModalOpen(false)}>
						Cancel
					</Button>
					<Button variant="default" size="sm" onClick={handleCreateFolderSubmit} disabled={!newFolderPath.trim()}>
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
				title="Delete Item"
				description={
					<>
						Are you sure you want to delete <strong className="text-text-primary">{deleteTarget}</strong>?
						<br />
						This action cannot be undone.
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
	onCreateFolderInDirectory?: (prefillPath: string) => void;
	onRenameFile?: (fromPath: string, toPath: string) => void;
	onMoveFile?: (fromPath: string, toPath: string) => void;
	dragOverPath: string | undefined;
	onDragOverPathChange: (path?: string) => void;
	renamingPath: string | undefined;
	onStartRename: (path: string) => void;
	onCancelRename: () => void;
	participants: Participant[];
	gitStatusMap?: Map<string, GitFileStatus>;
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
	onCreateFolderInDirectory,
	onRenameFile,
	onMoveFile,
	dragOverPath,
	onDragOverPathChange,
	renamingPath,
	onStartRename,
	onCancelRename,
	participants,
	gitStatusMap,
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
	const isDragOver = dragOverPath === item.path;
	const canDrag = onMoveFile && !isProtected && !isRenaming;
	// Git status: path in gitStatusMap uses no leading slash (e.g. "src/main.ts")
	const gitStatus =
		!item.isDirectory && gitStatusMap ? gitStatusMap.get(item.path.startsWith('/') ? item.path.slice(1) : item.path) : undefined;
	const gitColor = getGitStatusColor(gitStatus);
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
				draggable={canDrag ? true : undefined}
				onDragStart={
					canDrag
						? (event) => {
								event.dataTransfer.setData('text/x-file-path', item.path);
								event.dataTransfer.effectAllowed = 'move';
							}
						: undefined
				}
				onDragOver={
					item.isDirectory && onMoveFile
						? (event) => {
								event.preventDefault();
								event.stopPropagation();
								event.dataTransfer.dropEffect = 'move';
								onDragOverPathChange(item.path);
							}
						: undefined
				}
				onDragLeave={
					item.isDirectory && onMoveFile
						? (event) => {
								// Only clear if leaving the element entirely (not entering a child)
								const related = event.relatedTarget;
								if (!(related instanceof Node) || !event.currentTarget.contains(related)) {
									onDragOverPathChange();
								}
							}
						: undefined
				}
				onDrop={
					item.isDirectory && onMoveFile
						? (event) => {
								event.preventDefault();
								event.stopPropagation();
								onDragOverPathChange();
								const sourcePath = event.dataTransfer.getData('text/x-file-path');
								if (!sourcePath) return;
								// Prevent dropping onto self or into own subtree
								if (sourcePath === item.path || item.path.startsWith(sourcePath + '/')) return;
								const sourceName = sourcePath.split('/').pop()!;
								const newPath = `${item.path}/${sourceName}`;
								if (newPath !== sourcePath) {
									onMoveFile(sourcePath, newPath);
								}
							}
						: undefined
				}
				onDragEnd={
					onMoveFile
						? () => {
								onDragOverPathChange();
							}
						: undefined
				}
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
					isDragOver && item.isDirectory && 'bg-accent/10 ring-1 ring-accent ring-inset',
				)}
			>
				{item.isDirectory ? (
					<>
						<span
							className="
								flex size-4 shrink-0 items-center justify-center text-text-secondary
							"
						>
							{isExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
						</span>
						{isExpanded ? <FolderOpen className="size-4 shrink-0 text-accent" /> : <Folder className="size-4 shrink-0 text-accent" />}
					</>
				) : (
					<>
						<span className="size-4 shrink-0" />
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
					<span className={cn('min-w-0 flex-1 truncate', gitColor)} onDoubleClick={handleDoubleClick}>
						{item.name}
					</span>
				)}
				{isProtected && (
					<Tooltip content="Protected: Cannot be renamed or deleted">
						<Lock className="ml-1.5 size-3 shrink-0 text-text-secondary/50" />
					</Tooltip>
				)}
				{/* Collaborator presence dots — always visible */}
				{fileParticipants.length > 0 && (
					<div className="flex shrink-0 items-center gap-0.5">
						{fileParticipants.slice(0, 3).map((participant) => (
							<span key={participant.id} className="size-1.5 rounded-full" style={{ backgroundColor: participant.color }} />
						))}
						{fileParticipants.length > 3 && <span className="text-3xs text-text-secondary">+{fileParticipants.length - 3}</span>}
					</div>
				)}
				{/* Action buttons — hidden normally, shown on hover (zero layout space when hidden) */}
				{item.isDirectory && onCreateFileInDirectory && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleCreateInFolder}
						className="
							hidden size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary transition-colors
							hover-always:text-accent
							group-hover-always:flex
						"
						aria-label={`New file in ${item.name}`}
					>
						<FilePlus className="size-3" />
					</button>
				)}
				{item.isDirectory && onCreateFolderInDirectory && (
					<button
						type="button"
						tabIndex={-1}
						onClick={(event) => {
							event.stopPropagation();
							onCreateFolderInDirectory(`${item.path}/`);
						}}
						className="
							hidden size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary transition-colors
							hover-always:text-accent
							group-hover-always:flex
						"
						aria-label={`New folder in ${item.name}`}
					>
						<FolderPlus className="size-3" />
					</button>
				)}
				{!item.isDirectory && !isProtected && onRenameFile && !isRenaming && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleStartRename}
						className="
							hidden size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary transition-colors
							hover-always:text-accent
							group-hover-always:flex
						"
						aria-label={`Rename ${item.name}`}
					>
						<Pencil className="size-3" />
					</button>
				)}
				{!isProtected && onDeleteFile && !isRenaming && (
					<button
						type="button"
						tabIndex={-1}
						onClick={handleDelete}
						className="
							hidden size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary transition-colors
							hover-always:text-error
							group-hover-always:flex
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
							onCreateFolderInDirectory={onCreateFolderInDirectory}
							onRenameFile={onRenameFile}
							onMoveFile={onMoveFile}
							dragOverPath={dragOverPath}
							onDragOverPathChange={onDragOverPathChange}
							renamingPath={renamingPath}
							onStartRename={onStartRename}
							onCancelRename={onCancelRename}
							participants={participants}
							gitStatusMap={gitStatusMap}
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
