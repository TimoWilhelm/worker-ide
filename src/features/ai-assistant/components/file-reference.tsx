/**
 * File Reference Pill
 *
 * Renders a clickable file path pill that opens the file in the editor.
 * Used in user messages and assistant messages.
 */

import { FileText } from 'lucide-react';

import { Tooltip } from '@/components/ui/tooltip';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

/**
 * Clickable inline pill that opens a file in the editor.
 */
export function FileReference({
	path,
	className,
	interactive = true,
	onClick,
}: {
	path: string;
	className?: string;
	/**
	 * Set to false when rendered inside a button to avoid nested button violations.
	 * When false AND onClick is provided, renders as a clickable <span> with role="button".
	 */
	interactive?: boolean;
	/** Custom click handler — when provided in non-interactive mode, makes the pill clickable without nesting a <button>. */
	onClick?: (event: { stopPropagation: () => void }) => void;
}) {
	const openFile = useStore((state) => state.openFile);

	const fileName = path.split('/').findLast(Boolean) || path;

	const isClickable = interactive || !!onClick;

	const sharedClassName = cn(
		'inline-flex items-center gap-1 rounded-sm px-1.5 py-px',
		'bg-accent/15 font-mono text-xs text-accent',
		isClickable &&
			`
				cursor-pointer transition-colors
				hover:bg-accent/25
			`,
		className,
	);

	if (!interactive) {
		return (
			<Tooltip content={path} side="bottom">
				<span
					className={sharedClassName}
					role={onClick ? 'button' : undefined}
					tabIndex={onClick ? 0 : undefined}
					onClick={onClick}
					onKeyDown={
						onClick
							? (event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										onClick({ stopPropagation: () => event.stopPropagation() });
									}
								}
							: undefined
					}
				>
					<FileText className="size-3 shrink-0" />
					<span>{fileName}</span>
				</span>
			</Tooltip>
		);
	}

	return (
		<Tooltip content={path} side="bottom">
			<button type="button" onClick={() => openFile(path)} className={sharedClassName}>
				<FileText className="size-3 shrink-0" />
				<span>{fileName}</span>
			</button>
		</Tooltip>
	);
}
