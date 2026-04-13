/**
 * IDE header bar with project name, AI toggle, download, and mobile menu.
 */

import { BookOpen, Bot, Bug, Download, EllipsisVertical, Github, Hexagon, Pencil, Rocket, Settings } from 'lucide-react';
import { Link } from 'react-router';

import { BetaIndicator } from '@/components/beta-indicator';
import { BorderBeam } from '@/components/ui/border-beam';
import { Button } from '@/components/ui/button';
import { Modal, ModalBody } from '@/components/ui/modal';
import { Tooltip } from '@/components/ui/tooltip';
import { VersionBadge } from '@/components/version-badge';
import { NotificationToggle } from '@/features/notifications';
import { UserMenu } from '@/features/user-menu';
import { cn } from '@/lib/utils';

import type { useProjectName } from './use-project-name';

interface IDEHeaderProperties {
	projectNameState: ReturnType<typeof useProjectName>;
	isMobile: boolean;
	aiPanelVisible: boolean;
	toggleAgentPanel: () => void;
	isAgentProcessing: boolean;
	mobileMenuOpen: boolean;
	setMobileMenuOpen: (open: boolean) => void;
	onDownload: () => void;
	onDeploy: () => void;
	onSettings: () => void;
}

export function IDEHeader({
	projectNameState,
	isMobile,
	aiPanelVisible,
	toggleAgentPanel,
	isAgentProcessing,
	mobileMenuOpen,
	setMobileMenuOpen,
	onDownload,
	onDeploy,
	onSettings,
}: IDEHeaderProperties) {
	const {
		projectName,
		isEditingName,
		editNameValue,
		setEditNameValue,
		nameInputReference,
		handleStartRename,
		handleSaveRename,
		handleCancelRename,
	} = projectNameState;

	return (
		<>
			<header
				className="
					flex h-10 shrink-0 items-center justify-between border-b border-border
					bg-bg-secondary pr-3 wco-titlebar
				"
			>
				<div className="flex min-w-0 items-center gap-2 wco-interactive">
					<Tooltip content="Back to home">
						<Link
							to="/"
							className="
								flex shrink-0 items-center gap-1 text-accent transition-colors
								hover:text-accent-hover
							"
							aria-label="Back to home"
						>
							<Hexagon className="size-4" />
							<BetaIndicator />
						</Link>
					</Tooltip>
					{isEditingName ? (
						<div className="z-10 flex items-center gap-1">
							<input
								ref={nameInputReference}
								value={editNameValue}
								onChange={(event) => setEditNameValue(event.target.value)}
								onKeyDown={(event) => {
									if (event.key === 'Enter') void handleSaveRename();
									if (event.key === 'Escape') handleCancelRename();
								}}
								onBlur={() => void handleSaveRename()}
								className="
									h-6 w-40 rounded-sm border border-accent bg-bg-primary px-1.5 text-sm
									text-text-primary
									focus:outline-none
								"
								maxLength={60}
							/>
						</div>
					) : (
						<div className="group flex min-w-20 items-center gap-1.5">
							<h1
								className="cursor-pointer truncate font-semibold text-text-primary"
								onClick={handleStartRename}
								role="button"
								tabIndex={0}
								onKeyDown={(event) => {
									if (event.key === 'Enter' || event.key === ' ') {
										event.preventDefault();
										handleStartRename();
									}
								}}
							>
								{projectName ?? 'Codemaxxing'}
							</h1>
							<Tooltip content="Rename project">
								<button
									onClick={handleStartRename}
									className="
										cursor-pointer text-text-secondary opacity-0 transition-opacity
										pointer-coarse:hidden
										hover-always:text-accent
										group-hover-always:opacity-100
									"
									aria-label="Rename project"
								>
									<Pencil className="size-3" />
								</button>
							</Tooltip>
						</div>
					)}
				</div>
				<div className="flex shrink-0 items-center gap-2 wco-interactive">
					{/* AI toggle (desktop only — mobile uses bottom tab bar) */}
					{!isMobile && (
						<div className="relative">
							<Tooltip content="Toggle Agent panel">
								<Button
									variant="ghost"
									size="icon"
									aria-label="Toggle Agent panel"
									onClick={toggleAgentPanel}
									className={cn(aiPanelVisible && 'text-accent')}
								>
									<Bot className="size-4" />
								</Button>
							</Tooltip>
							{isAgentProcessing && !aiPanelVisible && <BorderBeam duration={1.5} />}
						</div>
					)}

					{/* Push notifications toggle */}
					<NotificationToggle />

					{/* Project Settings, Deploy, Download — desktop only */}
					{!isMobile && (
						<>
							<Tooltip content="Project settings">
								<Button variant="ghost" size="icon" aria-label="Project settings" onClick={onSettings}>
									<Settings className="size-4" />
								</Button>
							</Tooltip>

							<Tooltip content="Deploy to Cloudflare">
								<Button variant="ghost" size="icon" aria-label="Deploy to Cloudflare" onClick={onDeploy}>
									<Rocket className="size-4" />
								</Button>
							</Tooltip>

							<Tooltip content="Download project">
								<Button variant="ghost" size="icon" aria-label="Download project" onClick={onDownload}>
									<Download className="size-4" />
								</Button>
							</Tooltip>
						</>
					)}

					{/* More menu (mobile only — project actions + footer links) */}
					{isMobile && (
						<Tooltip content="More">
							<Button variant="ghost" size="icon" aria-label="More options" onClick={() => setMobileMenuOpen(true)}>
								<EllipsisVertical className="size-4" />
							</Button>
						</Tooltip>
					)}

					{/* User avatar dropdown — always visible */}
					<UserMenu size="sm" />
				</div>
			</header>

			{/* Mobile "More" menu — project actions + footer links */}
			<Modal open={mobileMenuOpen} onOpenChange={setMobileMenuOpen} title="More">
				<ModalBody className="flex flex-col gap-1">
					{/* ── Project section ── */}
					<button
						type="button"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
						onClick={() => {
							onSettings();
							setMobileMenuOpen(false);
						}}
					>
						<Settings className="size-4 text-text-secondary" />
						Project settings
					</button>
					<button
						type="button"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
						onClick={() => {
							onDeploy();
							setMobileMenuOpen(false);
						}}
					>
						<Rocket className="size-4 text-text-secondary" />
						Deploy to Cloudflare
					</button>
					<button
						type="button"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
						onClick={() => {
							onDownload();
							setMobileMenuOpen(false);
						}}
					>
						<Download className="size-4 text-text-secondary" />
						Download project
					</button>

					<div className="my-1 border-t border-border" role="separator" />

					{/* ── Links section ── */}
					<a
						href="/docs"
						target="_blank"
						rel="noopener noreferrer"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
					>
						<BookOpen className="size-4 text-text-secondary" />
						Documentation
					</a>
					<a
						href="https://github.com/TimoWilhelm/worker-ide"
						target="_blank"
						rel="noopener noreferrer"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
					>
						<Github className="size-4 text-text-secondary" />
						GitHub
					</a>
					<a
						href="https://github.com/TimoWilhelm/worker-ide/issues/new?template=bug-report.yml"
						target="_blank"
						rel="noopener noreferrer"
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-primary
							transition-colors
							hover:bg-bg-tertiary
						"
					>
						<Bug className="size-4 text-text-secondary" />
						Report a bug
					</a>

					<div
						className="
							flex items-center gap-3 rounded-md px-3 py-2 text-sm text-text-secondary
						"
					>
						<VersionBadge withProvider={false} />
					</div>
				</ModalBody>
			</Modal>
		</>
	);
}
