import { FileText } from 'lucide-react';
import { useCallback } from 'react';

import { Tooltip } from '@/components/ui/tooltip';
import {
	FILE_REFERENCE_BASE_CLASS_NAME,
	FILE_REFERENCE_INTERACTIVE_CLASS_NAME,
	FILE_REFERENCE_LABEL_CLASS_NAME,
} from '@/features/ai-assistant/lib/reference-pill-styles';
import { resolveFileTargetPath, useFileTargetOpener } from '@/lib/file-target';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

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
	onClick?: (event: { stopPropagation: () => void }) => void;
}) {
	const files = useStore((state) => state.files);
	const openFileTarget = useFileTargetOpener();

	const resolvedPath = resolveFileTargetPath(path, files);
	const fileName = resolvedPath.split('/').findLast(Boolean) || resolvedPath;
	const isClickable = interactive || !!onClick;

	const handleOpenReference = useCallback(() => {
		openFileTarget({ path });
	}, [openFileTarget, path]);

	const sharedClassName = cn(FILE_REFERENCE_BASE_CLASS_NAME, isClickable && FILE_REFERENCE_INTERACTIVE_CLASS_NAME, className);

	if (!interactive) {
		return (
			<Tooltip content={resolvedPath} side="bottom">
				<span
					className={sharedClassName}
					role={onClick ? 'button' : undefined}
					tabIndex={onClick ? 0 : undefined}
					onClick={
						onClick
							? (event) => {
									onClick({ stopPropagation: () => event.stopPropagation() });
									handleOpenReference();
								}
							: undefined
					}
					onKeyDown={
						onClick
							? (event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										onClick({ stopPropagation: () => event.stopPropagation() });
										handleOpenReference();
									}
								}
							: undefined
					}
				>
					<FileText className="size-3 shrink-0" />
					<span className={FILE_REFERENCE_LABEL_CLASS_NAME}>{fileName}</span>
				</span>
			</Tooltip>
		);
	}

	return (
		<Tooltip content={resolvedPath} side="bottom">
			<button type="button" onClick={handleOpenReference} className={sharedClassName}>
				<FileText className="size-3 shrink-0" />
				<span className={FILE_REFERENCE_LABEL_CLASS_NAME}>{fileName}</span>
			</button>
		</Tooltip>
	);
}
