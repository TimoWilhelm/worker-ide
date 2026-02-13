/**
 * File Tree Component
 *
 * Hierarchical file explorer with expand/collapse support.
 */

import { ChevronDown, ChevronRight, File, FilePlus, Folder, FolderOpen, Trash2 } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useCallback, useMemo, useState } from 'react';

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
	participants = [],
	className,
}: FileTreeProperties) {
	const tree = useMemo(() => buildFileTree(files), [files]);
	const [isCreateModalOpen, setIsCreateModalOpen] = useState(false);
	const [newFilePath, setNewFilePath] = useState('');
	const [deleteTarget, setDeleteTarget] = useState<string | undefined>();

	const handleCreateSubmit = useCallback(() => {
		const trimmed = newFilePath.trim();
		if (trimmed && onCreateFile) {
			const path = trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
			onCreateFile(path);
		}
		setIsCreateModalOpen(false);
		setNewFilePath('');
	}, [newFilePath, onCreateFile]);

	const handleOpenCreateModal = useCallback((prefillPath?: string) => {
		setNewFilePath(prefillPath ?? '');
		setIsCreateModalOpen(true);
	}, []);

	const handleDeleteRequest = useCallback((path: string) => {
		setDeleteTarget(path);
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
						<div className="py-1">
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
									participants={participants}
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
	participants: Participant[];
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
	participants,
}: FileTreeNodeProperties) {
	const isExpanded = expandedDirectories.has(item.path);
	const isSelected = selectedFile === item.path;
	const isProtected = !item.isDirectory && PROTECTED_FILES.has(item.path);
	const paddingLeft = `${depth * 12 + 12}px`;
	const fileParticipants = item.isDirectory ? [] : participants.filter((participant) => participant.file === item.path);

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
				<Tooltip content={item.path}>
					<span className="flex-1 truncate">{item.name}</span>
				</Tooltip>
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
						onClick={handleCreateInFolder}
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary opacity-0 transition-colors
							group-hover:opacity-100
							hover:text-accent
						"
						aria-label={`New file in ${item.name}`}
					>
						<FilePlus className="size-3" />
					</button>
				)}
				{!item.isDirectory && !isProtected && onDeleteFile && (
					<button
						onClick={handleDelete}
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary opacity-0 transition-colors
							group-hover:opacity-100
							hover:text-error
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
							participants={participants}
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
