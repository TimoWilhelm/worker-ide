/**
 * File Mention Dropdown Component
 *
 * Autocomplete dropdown for @-mentioning files in the AI chat input.
 * Renders a list of matching files with fuzzy-matched results.
 */

import { FileText, Folder } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';

import type { FileInfo } from '@shared/types';

/**
 * Get the file name from a path.
 */
function getFileName(path: string): string {
	return path.split('/').pop() ?? path;
}

/**
 * Get the directory portion of a path.
 */
function getDirectory(path: string): string {
	const lastSlash = path.lastIndexOf('/');
	return lastSlash > 0 ? path.slice(0, lastSlash) : '/';
}

export function FileMentionDropdown({
	results,
	selectedIndex,
	onSelect,
	className,
}: {
	results: FileInfo[];
	selectedIndex: number;
	onSelect: (index: number) => void;
	className?: string;
}) {
	const listReference = useRef<HTMLDivElement>(null);

	// Scroll selected item into view
	useEffect(() => {
		const list = listReference.current;
		if (!list) return;
		const selected = list.children[selectedIndex];
		if (selected instanceof HTMLElement) {
			selected.scrollIntoView({ block: 'nearest' });
		}
	}, [selectedIndex]);

	if (results.length === 0) {
		return (
			<div
				className={cn(
					'absolute bottom-full left-0 z-50 mb-1 w-full',
					'rounded-lg border border-border bg-bg-secondary shadow-lg',
					className,
				)}
			>
				<div className="px-3 py-2 text-xs text-text-secondary">No matching files</div>
			</div>
		);
	}

	return (
		<div
			ref={listReference}
			className={cn(
				'absolute bottom-full left-0 z-50 mb-1 max-h-56 w-full overflow-y-auto',
				'rounded-lg border border-border bg-bg-secondary shadow-lg',
				className,
			)}
		>
			{results.map((file, index) => (
				<button
					key={file.path}
					type="button"
					className={cn(
						`
							flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left
							text-xs
						`,
						'transition-colors',
						index === selectedIndex ? 'bg-accent/15 text-text-primary' : 'text-text-secondary hover:bg-bg-tertiary',
					)}
					onMouseDown={(event) => {
						// Prevent blur from firing on the textarea
						event.preventDefault();
						onSelect(index);
					}}
				>
					{file.isDirectory ? <Folder className="size-3 shrink-0 text-warning" /> : <FileText className="size-3 shrink-0 text-accent" />}
					<span className="truncate font-mono">{getFileName(file.path)}</span>
					<span className="ml-auto truncate text-2xs text-text-secondary">{getDirectory(file.path)}</span>
				</button>
			))}
		</div>
	);
}
