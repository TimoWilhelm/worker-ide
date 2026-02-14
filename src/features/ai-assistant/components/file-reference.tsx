/**
 * File Reference Pill
 *
 * Renders a clickable file path pill that opens the file in the editor.
 * Used in user messages and assistant messages.
 */

import { FileText } from 'lucide-react';

import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * Clickable inline pill that opens a file in the editor.
 */
export function FileReference({ path, className }: { path: string; className?: string }) {
	const openFile = useStore((state) => state.openFile);

	const fileName = path.split('/').at(-1) ?? path;

	return (
		<button
			type="button"
			onClick={() => openFile(path)}
			className={cn(
				'inline-flex cursor-pointer items-center gap-1 rounded-sm px-1.5 py-px',
				'bg-accent/15 font-mono text-xs text-accent',
				`
					transition-colors
					hover:bg-accent/25
				`,
				className,
			)}
			title={path}
		>
			<FileText className="size-3 shrink-0" />
			<span>{fileName}</span>
		</button>
	);
}
