import { Menu } from '@base-ui/react/menu';
import { motion } from 'motion/react';

import { popoverVariants, springSnappy } from '@/lib/motion-config';
import { cn } from '@/lib/utils';

import type { ReactElement, ReactNode, Ref } from 'react';

const DropdownMenu = Menu.Root;
const DropdownMenuGroup = Menu.Group;

interface DropdownMenuTriggerProperties {
	children: ReactElement<Record<string, unknown>>;
	disabled?: boolean;
}

function DropdownMenuTrigger({ children, disabled }: DropdownMenuTriggerProperties) {
	return <Menu.Trigger disabled={disabled} render={children} />;
}

interface DropdownMenuContentProperties {
	children: ReactNode;
	className?: string;
	align?: 'start' | 'center' | 'end';
	sideOffset?: number;
	ref?: Ref<HTMLDivElement>;
}

function DropdownMenuContent({ children, className, align = 'end', sideOffset = 4 }: DropdownMenuContentProperties) {
	return (
		<Menu.Portal>
			<Menu.Positioner align={align} sideOffset={sideOffset}>
				<Menu.Popup
					render={<motion.div variants={popoverVariants} initial="hidden" animate="visible" exit="exit" transition={springSnappy} />}
					className={cn(
						`
							z-50 min-w-32 overflow-hidden rounded-md border border-border
							bg-bg-secondary shadow-md
						`,
						className,
					)}
				>
					{children}
				</Menu.Popup>
			</Menu.Positioner>
		</Menu.Portal>
	);
}

interface DropdownMenuItemProperties {
	children: ReactNode;
	className?: string;
	disabled?: boolean;
	onSelect?: () => void;
	ref?: Ref<HTMLDivElement>;
	'aria-current'?: 'true' | undefined;
}

function DropdownMenuItem({ children, className, disabled, onSelect, ref, 'aria-current': ariaCurrent }: DropdownMenuItemProperties) {
	return (
		<Menu.Item
			ref={ref}
			disabled={disabled}
			onClick={onSelect}
			aria-current={ariaCurrent}
			className={cn(
				`
					relative flex cursor-pointer items-center gap-2 px-2 py-1.5 text-sm
					text-text-primary transition-colors outline-none select-none
					focus:bg-bg-tertiary focus:text-text-primary
					data-disabled:pointer-events-none data-disabled:opacity-50
				`,
				className,
			)}
		>
			{children}
		</Menu.Item>
	);
}

function DropdownMenuSeparator({ className }: { className?: string }) {
	return <Menu.Separator className={cn('my-1 h-px bg-border', className)} />;
}

function DropdownMenuLabel({ children, className }: { children: ReactNode; className?: string }) {
	return <div className={cn('px-2 py-1.5 text-xs font-medium text-text-secondary', className)}>{children}</div>;
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
