import { useEffect, useRef, type ReactNode } from 'react';

import { cn } from '@/lib/utils';

interface InlineRenameFieldProperties {
	isEditing: boolean;
	displayValue: string;
	inputValue: string;
	inputAriaLabel: string;
	onInputValueChange: (value: string) => void;
	onStartEditing: () => void;
	onSubmit: () => void | Promise<void>;
	onCancel: () => void;
	children: (properties: { displayValue: string; startEditing: () => void; isEditing: boolean }) => ReactNode;
	className?: string;
	displayWrapperClassName?: string;
	inputClassName?: string;
	inputWrapperClassName?: string;
	maxLength?: number;
	disabled?: boolean;
}

export function InlineRenameField({
	isEditing,
	displayValue,
	inputValue,
	inputAriaLabel,
	onInputValueChange,
	onStartEditing,
	onSubmit,
	onCancel,
	children,
	className,
	displayWrapperClassName,
	inputClassName,
	inputWrapperClassName,
	maxLength,
	disabled = false,
}: InlineRenameFieldProperties) {
	const inputReference = useRef<HTMLInputElement>(null);
	const skipSubmitOnBlurReference = useRef(false);

	useEffect(() => {
		if (!isEditing) {
			return;
		}

		const frameId = requestAnimationFrame(() => {
			inputReference.current?.focus();
			inputReference.current?.select();
		});

		return () => cancelAnimationFrame(frameId);
	}, [isEditing]);

	return (
		<div className={cn('relative', className)}>
			<div className={cn(isEditing && 'invisible', displayWrapperClassName)} aria-hidden={isEditing || undefined}>
				{children({ displayValue, startEditing: onStartEditing, isEditing })}
			</div>
			<div className={cn('absolute inset-0', !isEditing && 'pointer-events-none invisible', inputWrapperClassName)}>
				<input
					ref={inputReference}
					type="text"
					value={inputValue}
					onChange={(event) => onInputValueChange(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === 'Enter') {
							event.preventDefault();
							void onSubmit();
						}

						if (event.key === 'Escape') {
							event.preventDefault();
							skipSubmitOnBlurReference.current = true;
							onCancel();
						}
					}}
					onBlur={() => {
						if (skipSubmitOnBlurReference.current) {
							skipSubmitOnBlurReference.current = false;
							return;
						}

						void onSubmit();
					}}
					maxLength={maxLength}
					disabled={disabled}
					aria-label={inputAriaLabel}
					aria-hidden={!isEditing || undefined}
					tabIndex={isEditing ? 0 : -1}
					className={cn('w-full min-w-0', inputClassName)}
				/>
			</div>
		</div>
	);
}
