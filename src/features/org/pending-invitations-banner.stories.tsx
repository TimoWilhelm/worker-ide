import { Check, Mail, X } from 'lucide-react';
import { fn } from 'storybook/test';

import { cn } from '@/lib/utils';

import type { Meta, StoryObj } from '@storybook/react-vite';

// ---------------------------------------------------------------------------
// Presentational stand-in (mirrors the real component's render output)
// ---------------------------------------------------------------------------

interface Invitation {
	id: string;
	organizationName: string;
	organizationId: string;
	role?: string | undefined;
	status: string;
}

interface PendingInvitationsBannerPreviewProperties {
	invitations: Invitation[];
	onAccept: (invitationId: string) => void;
	onReject: (invitationId: string) => void;
	actingOnId?: string | undefined;
}

function PendingInvitationsBannerPreview({ invitations, onAccept, onReject, actingOnId }: PendingInvitationsBannerPreviewProperties) {
	if (invitations.length === 0) {
		return <p className="text-xs text-text-secondary">No pending invitations.</p>;
	}

	return (
		<section className="mb-8">
			<h2
				className="
					mb-3 text-xs font-medium tracking-wider text-text-secondary uppercase
				"
			>
				Pending invitations
			</h2>
			<div
				className={cn(
					`
						overflow-hidden rounded-lg border border-accent/30 bg-bg-secondary/40
						backdrop-blur-sm
					`,
					'divide-y divide-border',
				)}
			>
				{invitations.map((invitation) => {
					const isActing = actingOnId === invitation.id;
					return (
						<div key={invitation.id} className="flex items-center justify-between gap-3 px-4 py-3">
							<div className="flex min-w-0 items-center gap-3">
								<div
									className="
										flex size-8 shrink-0 items-center justify-center rounded-full
										bg-accent/10 text-accent
									"
								>
									<Mail className="size-3.5" />
								</div>
								<div className="min-w-0">
									<p className="truncate text-sm font-medium text-text-primary">{invitation.organizationName}</p>
									<p className="text-xs text-text-secondary">Invited as {invitation.role ?? 'member'}</p>
								</div>
							</div>
							<div className="flex shrink-0 items-center gap-1.5">
								<button
									onClick={() => onAccept(invitation.id)}
									disabled={isActing}
									title="Accept invitation"
									className="
										cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
										hover:bg-bg-tertiary hover:text-green-500
										disabled:pointer-events-none disabled:opacity-50
									"
								>
									<Check className="size-3.5" />
								</button>
								<button
									onClick={() => onReject(invitation.id)}
									disabled={isActing}
									title="Decline invitation"
									className="
										cursor-pointer rounded-md p-1.5 text-text-secondary transition-colors
										hover:bg-bg-tertiary hover:text-error
										disabled:pointer-events-none disabled:opacity-50
									"
								>
									<X className="size-3.5" />
								</button>
							</div>
						</div>
					);
				})}
			</div>
		</section>
	);
}

// ---------------------------------------------------------------------------
// Stories
// ---------------------------------------------------------------------------

const meta = {
	title: 'Features/Org/PendingInvitationsBanner',
	component: PendingInvitationsBannerPreview,
	args: {
		onAccept: fn(),
		onReject: fn(),
	},
} satisfies Meta<typeof PendingInvitationsBannerPreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const MultipleInvitations: Story = {
	args: {
		invitations: [
			{
				id: 'inv-1',
				organizationName: 'Acme Corp',
				organizationId: 'org-1',
				role: 'admin',
				status: 'pending',
			},
			{
				id: 'inv-2',
				organizationName: 'Globex Inc',
				organizationId: 'org-2',
				role: 'member',
				status: 'pending',
			},
			{
				id: 'inv-3',
				organizationName: 'Initech',
				organizationId: 'org-3',
				status: 'pending',
			},
		],
	},
};

export const SingleInvitation: Story = {
	args: {
		invitations: [
			{
				id: 'inv-1',
				organizationName: 'Acme Corp',
				organizationId: 'org-1',
				role: 'member',
				status: 'pending',
			},
		],
	},
};

export const NoInvitations: Story = {
	args: {
		invitations: [],
	},
};

export const ActingOnInvitation: Story = {
	args: {
		invitations: [
			{
				id: 'inv-1',
				organizationName: 'Acme Corp',
				organizationId: 'org-1',
				role: 'admin',
				status: 'pending',
			},
			{
				id: 'inv-2',
				organizationName: 'Globex Inc',
				organizationId: 'org-2',
				role: 'member',
				status: 'pending',
			},
		],
		actingOnId: 'inv-1',
	},
};
