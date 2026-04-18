import { LogOut, Palette, Settings, User } from 'lucide-react';
import { useLocation, useNavigate } from 'react-router';

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';
import { cn } from '@/lib/utils';

interface UserMenuProperties {
	size?: 'sm' | 'md';
}

export function UserMenu({ size = 'md' }: UserMenuProperties = {}) {
	const { data: session } = authClient.useSession();
	const navigate = useNavigate();
	const location = useLocation();

	if (!session?.user) return;

	const userName = session.user.name;
	const userEmail = session.user.email;
	const userImage = session.user.image ?? undefined;

	const initials = userName
		.split(' ')
		.map((part) => part.charAt(0))
		.join('')
		.toUpperCase()
		.slice(0, 2);
	const settingsNavigationState = {
		from: `${location.pathname}${location.search}${location.hash}`,
	};

	return (
		<DropdownMenu>
			<DropdownMenuTrigger>
				<button
					data-local-focus="true"
					className={cn(
						`
							flex shrink-0 cursor-pointer items-center justify-center rounded-full
							border transition-colors
							focus-visible:ring-2 focus-visible:ring-accent
							focus-visible:ring-offset-2 focus-visible:ring-offset-bg-primary
							focus-visible:outline-none
						`,
						size === 'sm'
							? `
								size-6 border-transparent
								hover:border-accent/50
							`
							: `
								size-8 border-border bg-bg-secondary/40 backdrop-blur-sm
								hover:border-accent/50 hover:bg-bg-secondary/80
							`,
					)}
					aria-label="User menu"
				>
					{userImage ? (
						<img src={userImage} alt={userName} className={cn('rounded-full object-cover', size === 'sm' ? 'size-6' : 'size-8')} />
					) : (
						<span className={cn('font-medium text-text-secondary', size === 'sm' ? 'text-2xs' : 'text-xs')}>{initials}</span>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				<div className="px-3 py-2">
					<p className="truncate text-sm font-medium text-text-primary">{userName}</p>
					<p className="truncate text-xs text-text-secondary">{userEmail}</p>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						void navigate('/settings/profile', { state: settingsNavigationState });
					}}
					className="gap-2 text-xs"
				>
					<User className="size-3.5 shrink-0 text-text-secondary" />
					<span>Profile</span>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						void navigate('/settings/account', { state: settingsNavigationState });
					}}
					className="gap-2 text-xs"
				>
					<Settings className="size-3.5 shrink-0 text-text-secondary" />
					<span>Account</span>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						void navigate('/settings/appearance', { state: settingsNavigationState });
					}}
					className="gap-2 text-xs"
				>
					<Palette className="size-3.5 shrink-0 text-text-secondary" />
					<span>Appearance</span>
				</DropdownMenuItem>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						void authClient.signOut().then(
							() => {
								globalThis.location.href = '/';
							},
							() => {
								toast.error('Could not sign out. Please check your connection and try again.');
							},
						);
					}}
					className="gap-2 text-xs text-text-secondary"
				>
					<LogOut className="size-3.5 shrink-0" />
					<span>Sign out</span>
				</DropdownMenuItem>
			</DropdownMenuContent>
		</DropdownMenu>
	);
}
