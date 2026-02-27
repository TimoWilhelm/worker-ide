/**
 * IDE status bar (footer) showing connection state, participants, and links.
 */

import { Github } from 'lucide-react';

import { VersionBadge } from '@/components/version-badge';

interface IDEStatusBarProperties {
	isConnected: boolean;
	localParticipantColor: string | undefined;
	participants: Array<{ id: string; color: string }>;
	isSaving: boolean;
}

export function IDEStatusBar({ isConnected, localParticipantColor, participants, isSaving }: IDEStatusBarProperties) {
	return (
		<footer
			className="
				flex h-6 shrink-0 items-center justify-between border-t border-border
				bg-bg-secondary px-3 text-xs text-text-secondary
			"
		>
			<div className="flex min-w-0 items-center gap-4 overflow-hidden">
				{isConnected ? (
					<span className="flex items-center gap-1.5 overflow-hidden">
						<span className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: localParticipantColor ?? 'var(--color-success)' }} />
						<span className="shrink-0">Connected</span>
						{participants.length > 0 && (
							<span className="flex items-center gap-1 overflow-hidden">
								<span className="shrink-0 text-text-secondary">&middot;</span>
								{participants.map((participant) => (
									<span
										key={participant.id}
										className="size-2 shrink-0 rounded-full"
										style={{ backgroundColor: participant.color }}
										title={`Collaborator (${participant.id.slice(0, 6)})`}
									/>
								))}
								<span className="shrink-0 text-text-secondary">{participants.length} online</span>
							</span>
						)}
					</span>
				) : localParticipantColor ? (
					<span className="flex items-center gap-1.5">
						<span className="size-1.5 shrink-0 animate-pulse rounded-full" style={{ backgroundColor: localParticipantColor }} />
						Reconnecting
					</span>
				) : (
					<span className="flex items-center gap-1.5">
						<span className="size-1.5 shrink-0 rounded-full bg-error" />
						Disconnected
					</span>
				)}
			</div>
			<div className="flex shrink-0 items-center gap-4">
				{isSaving && <span>Saving...</span>}
				<a
					href="https://github.com/TimoWilhelm/worker-ide"
					target="_blank"
					rel="noopener noreferrer"
					className="
						transition-colors
						hover:text-accent
					"
					title="GitHub"
				>
					<Github className="size-3.5" />
				</a>
				<a href="/docs" target="_blank" rel="noopener noreferrer" className="transition-colors hover:text-accent">
					Worker IDE
				</a>
				<VersionBadge withProvider={false} />
			</div>
		</footer>
	);
}
