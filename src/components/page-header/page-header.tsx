import { ArrowLeft, Menu } from 'lucide-react';
import { useNavigate } from 'react-router';

import { Button } from '@/components/ui/button';
import { OrgSwitcher } from '@/features/org/org-switcher';
import { UserMenu } from '@/features/user-menu';
import { useScrollThreshold } from '@/hooks/use-scroll-threshold';
import { cn } from '@/lib/utils';

interface OrganizationSwitcherProperties {
	organizations: Array<{ id: string; name: string; slug: string; logo?: string | null }>;
	currentOrganizationId: string;
	currentOrganizationName: string;
	getOrganizationPath?: (organization: { id: string; name: string; slug: string; logo?: string | null }) => string;
}

interface PageHeaderProperties {
	variant?: 'solid' | 'floating';
	title?: string;
	backTo?: string;
	onOpenNavigationMenu?: () => void;
	organizationSwitcher?: OrganizationSwitcherProperties;
	scrollContainer?: HTMLElement;
}

export function PageHeader({
	variant = 'solid',
	title,
	backTo,
	onOpenNavigationMenu,
	organizationSwitcher,
	scrollContainer,
}: PageHeaderProperties) {
	const navigate = useNavigate();
	const isFloating = variant === 'floating';
	const showBackdrop = useScrollThreshold({
		element: scrollContainer,
		disabled: !isFloating,
	});

	return (
		<header
			className={cn(
				'z-30 w-full',
				isFloating
					? [
							'fixed inset-x-0 top-0',
							`
								transition-[background-color,border-color,backdrop-filter] duration-200
								ease-out
							`,
							showBackdrop ? 'border-b border-border bg-bg-primary/60 backdrop-blur-xl' : 'border-b border-transparent bg-transparent',
						]
					: 'shrink-0 border-b border-border bg-bg-secondary',
			)}
		>
			<div className={cn('mx-auto flex w-full items-center justify-between gap-3 px-4 sm:px-6', isFloating ? 'h-14' : 'h-12')}>
				<div className="flex min-w-0 items-center gap-3">
					{onOpenNavigationMenu && (
						<Button variant="ghost" size="icon" onClick={onOpenNavigationMenu} className="sm:hidden" aria-label="Open settings menu">
							<Menu className="size-4" />
						</Button>
					)}

					{backTo && (
						<Button variant="ghost" size="icon" onClick={() => void navigate(backTo)} aria-label="Go back">
							<ArrowLeft className="size-4" />
						</Button>
					)}

					{title && <h1 className="min-w-0 truncate text-sm font-semibold text-text-primary">{title}</h1>}
				</div>

				<div className="flex shrink-0 items-center gap-1">
					{organizationSwitcher && (
						<OrgSwitcher
							organizations={organizationSwitcher.organizations}
							currentOrganizationId={organizationSwitcher.currentOrganizationId}
							currentOrganizationName={organizationSwitcher.currentOrganizationName}
							getOrganizationPath={organizationSwitcher.getOrganizationPath}
						/>
					)}

					<UserMenu />
				</div>
			</div>
		</header>
	);
}
