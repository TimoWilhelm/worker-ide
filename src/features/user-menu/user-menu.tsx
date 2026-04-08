/**
 * User Menu
 *
 * Avatar dropdown menu shown in the dashboard header.
 * Displays user info and links to profile, account settings, and sign out.
 */

import { LogOut, Settings, User } from 'lucide-react';
import { useNavigate } from 'react-router';

import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { toast } from '@/components/ui/toast-store';
import { authClient } from '@/lib/auth-client';

interface UserMenuProperties {
	userName: string;
	userEmail: string;
	userImage?: string;
}

export function UserMenu({ userName, userEmail, userImage }: UserMenuProperties) {
	const navigate = useNavigate();
	const initials = userName
		.split(' ')
		.map((part) => part.charAt(0))
		.join('')
		.toUpperCase()
		.slice(0, 2);

	return (
		<DropdownMenu>
			<DropdownMenuTrigger>
				<button
					className="
						flex size-8 shrink-0 cursor-pointer items-center justify-center
						rounded-full border border-border bg-bg-secondary/40 backdrop-blur-sm
						transition-colors
						hover:border-accent/50 hover:bg-bg-secondary/80
						focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2
						focus-visible:ring-offset-bg-primary focus-visible:outline-none
					"
					aria-label="User menu"
				>
					{userImage ? (
						<img src={userImage} alt={userName} className="size-8 rounded-full object-cover" />
					) : (
						<span className="text-xs font-medium text-text-secondary">{initials}</span>
					)}
				</button>
			</DropdownMenuTrigger>
			<DropdownMenuContent align="end" className="min-w-52">
				{/* User info */}
				<div className="px-3 py-2">
					<p className="truncate text-sm font-medium text-text-primary">{userName}</p>
					<p className="truncate text-xs text-text-secondary">{userEmail}</p>
				</div>
				<DropdownMenuSeparator />
				<DropdownMenuItem
					onSelect={() => {
						void navigate('/settings/profile');
					}}
					className="gap-2 text-xs"
				>
					<User className="size-3.5 shrink-0 text-text-secondary" />
					<span>Profile</span>
				</DropdownMenuItem>
				<DropdownMenuItem
					onSelect={() => {
						void navigate('/settings/account');
					}}
					className="gap-2 text-xs"
				>
					<Settings className="size-3.5 shrink-0 text-text-secondary" />
					<span>Account</span>
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
