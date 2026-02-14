/**
 * Dropdown Menu Component
 *
 * Accessible dropdown menu using radix-ui primitives.
 */

import { DropdownMenu as RadixDropdownMenu } from 'radix-ui';

import { cn } from '@/lib/utils';

import type { ReactNode, Ref } from 'react';

// =============================================================================
// Root + Trigger
// =============================================================================

const DropdownMenu = RadixDropdownMenu.Root;
const DropdownMenuTrigger = RadixDropdownMenu.Trigger;
const DropdownMenuGroup = RadixDropdownMenu.Group;

// =============================================================================
// Content
// =============================================================================

interface DropdownMenuContentProperties {
	children: ReactNode;
	className?: string;
	align?: 'start' | 'center' | 'end';
	sideOffset?: number;
	ref?: Ref<HTMLDivElement>;
}

function DropdownMenuContent({ children, className, align = 'end', sideOffset = 4, ref }: DropdownMenuContentProperties) {
	return (
		<RadixDropdownMenu.Portal>
			<RadixDropdownMenu.Content
				ref={ref}
				align={align}
				sideOffset={sideOffset}
				className={cn(
					`
						z-50 min-w-32 overflow-hidden rounded-md border border-border
						bg-bg-secondary p-1 shadow-md
					`,
					className,
				)}
			>
				{children}
			</RadixDropdownMenu.Content>
		</RadixDropdownMenu.Portal>
	);
}

// =============================================================================
// Item
// =============================================================================

interface DropdownMenuItemProperties {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	onSelect?: () => void;
	ref?: Ref<HTMLDivElement>;
}

function DropdownMenuItem({ children, className, disabled, onSelect, ref }: DropdownMenuItemProperties) {
	return (
		<RadixDropdownMenu.Item
			ref={ref}
			disabled={disabled}
			onSelect={onSelect}
			className={cn(
				`
					relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5
					text-sm text-text-primary transition-colors outline-none select-none
					focus:bg-bg-tertiary focus:text-text-primary
					data-disabled:pointer-events-none data-disabled:opacity-50
				`,
				className,
			)}
		>
			{children}
		</RadixDropdownMenu.Item>
	);
}

// =============================================================================
// Separator + Label
// =============================================================================

function DropdownMenuSeparator({ className }: { className?: string }) {
	return <RadixDropdownMenu.Separator className={cn('-mx-1 my-1 h-px bg-border', className)} />;
}

function DropdownMenuLabel({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<RadixDropdownMenu.Label className={cn('px-2 py-1.5 text-xs font-medium text-text-secondary', className)}>
			{children}
		</RadixDropdownMenu.Label>
	);
}

export {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuGroup,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
};
