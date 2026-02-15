/**
 * File Tabs Component
 *
 * Horizontal tab bar for open files with close buttons.
 * Supports: long file name tooltips, directory disambiguation for duplicates,
 * collaborator presence dots per file.
 */

import { File, X } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useCallback, useEffect, useMemo, useRef } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

import type { Participant } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

export interface FileTab {
	path: string;
	hasUnsavedChanges?: boolean;
}

export interface FileTabsProperties {
	/** List of open files */
	tabs: FileTab[];
	/** Currently active file path */
	activeTab: string | undefined;
	/** Called when a tab is selected */
	onSelect: (path: string) => void;
	/** Called when a tab close button is clicked */
	onClose: (path: string) => void;
	/** Connected collaborators for showing presence dots */
	participants?: Participant[];
	/** CSS class name */
	className?: string;
}

// =============================================================================
// Utilities
// =============================================================================

/**
 * Get filename from path.
 */
function getFilename(path: string): string {
	const parts = path.split('/');
	return parts.at(-1) || path;
}

/**
 * Get parent directory name from path.
 */
function getParentDirectory(path: string): string {
	const parts = path.split('/').filter(Boolean);
	return parts.length > 1 ? (parts.at(-2) ?? '') : '';
}

/**
 * Get file icon color based on extension.
 */
function getFileIconColor(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
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

/**
 * Build a map of filenames that appear multiple times across open tabs.
 * Returns a set of paths that need disambiguation (parent directory shown).
 */
function getDuplicateBasenames(tabs: FileTab[]): Set<string> {
	const basenameCount = new Map<string, string[]>();
	for (const tab of tabs) {
		const basename = getFilename(tab.path);
		const existing = basenameCount.get(basename) ?? [];
		existing.push(tab.path);
		basenameCount.set(basename, existing);
	}
	const duplicates = new Set<string>();
	for (const paths of basenameCount.values()) {
		if (paths.length > 1) {
			for (const path of paths) {
				duplicates.add(path);
			}
		}
	}
	return duplicates;
}

/** Prevent pointerdown from bubbling to Tabs.Trigger (which activates on pointerdown). */
function handleClosePointerDown(event: React.PointerEvent) {
	event.stopPropagation();
}

// =============================================================================
// Component
// =============================================================================

/**
 * File tabs component for the editor.
 */
export function FileTabs({ tabs, activeTab, onSelect, onClose, participants = [], className }: FileTabsProperties) {
	const duplicates = useMemo(() => getDuplicateBasenames(tabs), [tabs]);
	const listReference = useRef<HTMLDivElement>(null);

	// Scroll the active tab into view when it changes
	useEffect(() => {
		if (!activeTab || !listReference.current) return;
		const activeElement = listReference.current.querySelector<HTMLElement>(`[data-state="active"]`);
		if (activeElement) {
			activeElement.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
		}
	}, [activeTab]);

	// Allow horizontal scrolling with the mouse wheel
	const handleWheel = useCallback((event: React.WheelEvent) => {
		if (listReference.current && event.deltaY !== 0) {
			listReference.current.scrollLeft += event.deltaY;
		}
	}, []);

	// Pointer drag-to-scroll (mouse + touch, like VS Code)
	const dragState = useRef<{ isDown: boolean; startX: number; scrollLeft: number }>({
		isDown: false,
		startX: 0,
		scrollLeft: 0,
	});

	const handlePointerDown = useCallback((event: React.PointerEvent) => {
		const list = listReference.current;
		if (!list) return;
		// Only drag on primary button (left click / single touch)
		if (event.button !== 0) return;
		dragState.current = { isDown: true, startX: event.clientX, scrollLeft: list.scrollLeft };
		list.setPointerCapture(event.pointerId);
	}, []);

	const handlePointerMove = useCallback((event: React.PointerEvent) => {
		if (!dragState.current.isDown || !listReference.current) return;
		const deltaX = event.clientX - dragState.current.startX;
		listReference.current.scrollLeft = dragState.current.scrollLeft - deltaX;
	}, []);

	const handlePointerUp = useCallback((event: React.PointerEvent) => {
		dragState.current.isDown = false;
		listReference.current?.releasePointerCapture(event.pointerId);
	}, []);

	if (tabs.length === 0) {
		return (
			<div className={cn('flex h-tabs items-center border-b border-border bg-bg-secondary px-4', className)}>
				<span className="text-sm text-text-secondary">No files open</span>
			</div>
		);
	}

	return (
		<Tabs.Root value={activeTab} onValueChange={onSelect} className={cn('shrink-0', className)}>
			<Tabs.List
				ref={listReference}
				onWheel={handleWheel}
				onPointerDown={handlePointerDown}
				onPointerMove={handlePointerMove}
				onPointerUp={handlePointerUp}
				onPointerCancel={handlePointerUp}
				className="
					flex h-tabs items-end gap-0 overflow-x-auto border-b border-border
					bg-bg-secondary select-none
				"
				style={{ scrollbarWidth: 'none' }}
			>
				{tabs.map((tab) => (
					<FileTabItem
						key={tab.path}
						tab={tab}
						isActive={tab.path === activeTab}
						showDirectory={duplicates.has(tab.path)}
						participants={participants.filter((participant) => participant.file === tab.path)}
						onClose={() => onClose(tab.path)}
					/>
				))}
			</Tabs.List>
		</Tabs.Root>
	);
}

// =============================================================================
// Tab Item Component
// =============================================================================

interface FileTabItemProperties {
	tab: FileTab;
	isActive: boolean;
	showDirectory: boolean;
	participants: Participant[];
	onClose: () => void;
}

function FileTabItem({ tab, isActive, showDirectory, participants, onClose }: FileTabItemProperties) {
	const filename = getFilename(tab.path);
	const iconColor = getFileIconColor(tab.path);
	const parentDirectory = showDirectory ? getParentDirectory(tab.path) : '';

	const handleClose = (event: React.SyntheticEvent) => {
		event.stopPropagation();
		onClose();
	};

	const handleMiddleClick = (event: React.MouseEvent) => {
		if (event.button === 1) {
			event.preventDefault();
			onClose();
		}
	};

	const closeLabel = showDirectory ? `Close ${tab.path}` : `Close ${filename}`;

	return (
		<Tabs.Trigger
			value={tab.path}
			onMouseDown={handleMiddleClick}
			className={cn(
				`
					group relative flex h-9 items-center gap-2 border-r border-border px-4
					text-sm transition-colors
				`,
				`
					hover:bg-bg-tertiary
					focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none
					focus-visible:ring-inset
				`,
				isActive
					? `
						bg-bg-primary text-text-primary
						before:absolute before:inset-x-0 before:bottom-0 before:h-[2px]
						before:bg-accent
					`
					: `
						bg-bg-secondary text-text-secondary
						hover:text-text-primary
					`,
			)}
		>
			<File className={cn('size-3.5 shrink-0', iconColor)} />
			<Tooltip content={tab.path}>
				<span className="max-w-terminal truncate">
					{filename}
					{parentDirectory && <span className="ml-1 text-text-secondary opacity-60">&#8249;{parentDirectory}&#8250;</span>}
				</span>
			</Tooltip>
			{/* Collaborator presence dots */}
			{participants.length > 0 && (
				<div className="flex shrink-0 items-center gap-0.5">
					{participants.slice(0, 3).map((participant) => (
						<span key={participant.id} className="size-1.5 rounded-full" style={{ backgroundColor: participant.color }} />
					))}
					{participants.length > 3 && <span className="text-3xs text-text-secondary">+{participants.length - 3}</span>}
				</div>
			)}
			{tab.hasUnsavedChanges && (
				<Tooltip content="Unsaved changes">
					<span className="size-2 shrink-0 rounded-full bg-accent" />
				</Tooltip>
			)}
			<Tooltip content="Close">
				<button
					type="button"
					aria-label={closeLabel}
					onPointerDown={handleClosePointerDown}
					onClick={handleClose}
					className={cn(
						`
							ml-1 flex size-4 shrink-0 items-center justify-center rounded-sm
							transition-colors
						`,
						`
							opacity-0
							group-hover:opacity-100
							hover:bg-bg-tertiary
							focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-accent
							focus-visible:outline-none focus-visible:ring-inset
						`,
						isActive && 'opacity-100',
					)}
				>
					<X className="size-3" />
				</button>
			</Tooltip>
		</Tabs.Trigger>
	);
}
