/**
 * File Tabs Component
 *
 * Horizontal tab bar for open files with close buttons.
 */

import { X } from 'lucide-react';
import { Tabs } from 'radix-ui';

import { Tooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

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
 * Get file icon based on extension.
 */
function getFileIcon(path: string): string {
	const extension = path.split('.').pop()?.toLowerCase();
	switch (extension) {
		case 'ts':
		case 'tsx': {
			return '📘';
		}
		case 'js':
		case 'jsx': {
			return '📙';
		}
		case 'css': {
			return '🎨';
		}
		case 'html': {
			return '🌐';
		}
		case 'json': {
			return '📋';
		}
		case 'md': {
			return '📝';
		}
		default: {
			return '📄';
		}
	}
}

// =============================================================================
// Component
// =============================================================================

/**
 * File tabs component for the editor.
 */
export function FileTabs({ tabs, activeTab, onSelect, onClose, className }: FileTabsProperties) {
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
				className="
					flex h-tabs items-end gap-0 overflow-x-auto border-b border-border
					bg-bg-secondary
				"
			>
				{tabs.map((tab) => (
					<FileTabItem key={tab.path} tab={tab} isActive={tab.path === activeTab} onClose={() => onClose(tab.path)} />
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
	onClose: () => void;
}

function FileTabItem({ tab, isActive, onClose }: FileTabItemProperties) {
	const filename = getFilename(tab.path);
	const icon = getFileIcon(tab.path);

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

	const handleCloseKeyDown = (event: React.KeyboardEvent) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			handleClose(event);
		}
	};

	return (
		<Tabs.Trigger
			value={tab.path}
			onMouseDown={handleMiddleClick}
			className={cn(
				`
					group relative flex h-[37px] items-center gap-2 border-r border-border px-3
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
			<span className="text-xs">{icon}</span>
			<span className="max-w-[120px] truncate">{filename}</span>
			{tab.hasUnsavedChanges && (
				<Tooltip content="Unsaved changes">
					<span className="size-2 rounded-full bg-accent" />
				</Tooltip>
			)}
			<Tooltip content="Close">
				<span
					role="button"
					aria-label="Close"
					tabIndex={0}
					onClick={handleClose}
					onKeyDown={handleCloseKeyDown}
					className={cn(
						`
							ml-1 flex size-4 items-center justify-center rounded-sm transition-colors
						`,
						`
							opacity-0
							group-hover:opacity-100
							hover:bg-bg-tertiary
						`,
						isActive && 'opacity-100',
					)}
				>
					<X className="size-3" />
				</span>
			</Tooltip>
		</Tabs.Trigger>
	);
}
