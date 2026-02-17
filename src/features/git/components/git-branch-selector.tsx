/**
 * Git Branch Selector
 *
 * Dropdown showing current branch with ability to switch branches.
 */

import { ChevronDown, GitBranch } from 'lucide-react';

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui';
import { cn } from '@/lib/utils';

import type { GitBranchInfo } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitBranchSelectorProperties {
	branches: GitBranchInfo[];
	currentBranch: string | undefined;
	onCheckout: (reference: string) => void;
	onCreateBranch: () => void;
	disabled?: boolean;
}

// =============================================================================
// Component
// =============================================================================

export function GitBranchSelector({ branches, currentBranch, onCheckout, onCreateBranch, disabled }: GitBranchSelectorProperties) {
	return (
		<DropdownMenu>
			<DropdownMenuTrigger asChild>
				<button
					type="button"
					disabled={disabled}
					className={cn(
						'flex items-center gap-1.5 rounded-md px-2 py-1 text-xs',
						`
							text-text-secondary transition-colors
							hover:bg-bg-tertiary hover:text-text-primary
						`,
						disabled && 'cursor-not-allowed opacity-50',
					)}
				>
					<GitBranch className="size-3" />
					<span className="max-w-[120px] truncate">{currentBranch ?? 'HEAD'}</span>
					<ChevronDown className="size-3" />
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="start" sideOffset={4}>
				<DropdownMenuLabel>Branches</DropdownMenuLabel>
				{branches.map((branch) => (
					<DropdownMenuItem key={branch.name} onSelect={() => onCheckout(branch.name)} disabled={branch.isCurrent}>
						<GitBranch className="mr-2 size-3" />
						<span className="truncate">{branch.name}</span>
						{branch.isCurrent && <span className="ml-auto text-xs text-accent">current</span>}
					</DropdownMenuItem>
				))}
				{branches.length > 0 && <DropdownMenuSeparator />}
				<DropdownMenuItem onSelect={onCreateBranch}>Create new branch...</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
