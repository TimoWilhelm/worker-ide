/**
 * Project Settings Modal
 *
 * Modal dialog for configuring Cloudflare Workers asset routing settings.
 * Controls not_found_handling, html_handling, and run_worker_first.
 */

import { useSuspenseQuery } from '@tanstack/react-query';
import { Suspense, useCallback, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Modal, ModalBody, ModalFooter } from '@/components/ui/modal';
import { fetchProjectMeta, updateAssetSettings } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import type { AssetSettings, HtmlHandling, NotFoundHandling } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface ProjectSettingsModalProperties {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
}

type RunWorkerFirstMode = 'off' | 'all' | 'patterns';

// =============================================================================
// Constants
// =============================================================================

const NOT_FOUND_HANDLING_OPTIONS: Array<{ value: NotFoundHandling; label: string; description: string }> = [
	{ value: 'none', label: 'None', description: 'Return 404 for unmatched requests (default)' },
	{
		value: 'single-page-application',
		label: 'Single Page Application',
		description: 'Serve index.html for unmatched requests',
	},
	{ value: '404-page', label: '404 Page', description: 'Serve nearest 404.html with 404 status' },
];

const HTML_HANDLING_OPTIONS: Array<{ value: HtmlHandling; label: string; description: string }> = [
	{
		value: 'auto-trailing-slash',
		label: 'Auto Trailing Slash',
		description: 'Automatically add or remove trailing slashes (default)',
	},
	{
		value: 'force-trailing-slash',
		label: 'Force Trailing Slash',
		description: 'Always redirect to URLs with trailing slash',
	},
	{
		value: 'drop-trailing-slash',
		label: 'Drop Trailing Slash',
		description: 'Always redirect to URLs without trailing slash',
	},
	{ value: 'none', label: 'None', description: 'No trailing slash redirects' },
];

const INPUT_CLASSES = cn(
	`
		h-8 rounded-sm border border-border bg-bg-primary px-2.5 text-sm
		text-text-primary
	`,
	'placeholder:text-text-secondary/50',
	'focus:border-accent focus:outline-none',
	'disabled:opacity-50',
);

// =============================================================================
// Helpers
// =============================================================================

function getRunWorkerFirstMode(runWorkerFirst: boolean | string[] | undefined): RunWorkerFirstMode {
	if (runWorkerFirst === true) return 'all';
	if (Array.isArray(runWorkerFirst) && runWorkerFirst.length > 0) return 'patterns';
	return 'off';
}

function getRunWorkerFirstPatterns(runWorkerFirst: boolean | string[] | undefined): string {
	if (Array.isArray(runWorkerFirst)) return runWorkerFirst.join('\n');
	return '';
}

const HTML_HANDLING_MAP: Record<string, HtmlHandling> = {
	'auto-trailing-slash': 'auto-trailing-slash',
	'force-trailing-slash': 'force-trailing-slash',
	'drop-trailing-slash': 'drop-trailing-slash',
	none: 'none',
};

function parseHtmlHandling(value: string): HtmlHandling {
	return HTML_HANDLING_MAP[value] ?? 'auto-trailing-slash';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Outer wrapper that handles modal open/close state.
 * Renders content only when open for fresh state on each mount.
 */
export function ProjectSettingsModal({ open, onOpenChange, projectId }: ProjectSettingsModalProperties) {
	return (
		<Modal open={open} onOpenChange={onOpenChange} title="Project Settings" className="w-[480px]">
			{open && (
				<Suspense
					fallback={
						<ModalBody className="flex h-[460px] items-center justify-center">
							<p className="text-sm text-text-secondary">Loading settings...</p>
						</ModalBody>
					}
				>
					<ProjectSettingsContent onOpenChange={onOpenChange} projectId={projectId} />
				</Suspense>
			)}
		</Modal>
	);
}

/**
 * Inner content that holds form state.
 * Remounts each time the modal opens, so state is always fresh.
 */
function ProjectSettingsContent({ onOpenChange, projectId }: { onOpenChange: (open: boolean) => void; projectId: string }) {
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();

	// Load current settings via React Query (suspends until data is available)
	const settingsQuery = useSuspenseQuery({
		queryKey: ['project-settings', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 0,
	});
	const loadedSettings = settingsQuery.data.assetSettings;

	// Asset settings form state — initialized from loaded data
	const [notFoundHandling, setNotFoundHandling] = useState<NotFoundHandling>(() => loadedSettings?.not_found_handling ?? 'none');
	const [htmlHandling, setHtmlHandling] = useState<HtmlHandling>(() => loadedSettings?.html_handling ?? 'auto-trailing-slash');
	const [runWorkerFirstMode, setRunWorkerFirstMode] = useState<RunWorkerFirstMode>(() =>
		getRunWorkerFirstMode(loadedSettings?.run_worker_first),
	);
	const [runWorkerFirstPatterns, setRunWorkerFirstPatterns] = useState(() => getRunWorkerFirstPatterns(loadedSettings?.run_worker_first));

	const displayError = error;

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setError(undefined);

		try {
			const assetSettings: AssetSettings = {};

			// Only include non-default values
			if (notFoundHandling !== 'none') {
				assetSettings.not_found_handling = notFoundHandling;
			}
			if (htmlHandling !== 'auto-trailing-slash') {
				assetSettings.html_handling = htmlHandling;
			}

			if (runWorkerFirstMode === 'all') {
				assetSettings.run_worker_first = true;
			} else if (runWorkerFirstMode === 'patterns') {
				const patterns = runWorkerFirstPatterns
					.split('\n')
					.map((p) => p.trim())
					.filter(Boolean);
				const invalidPattern = patterns.find((p) => !p.startsWith('/') && !p.startsWith('!/'));
				if (invalidPattern) {
					setError(`Invalid route pattern: "${invalidPattern}". Patterns must begin with / or !/`);
					setIsSaving(false);
					return;
				}
				if (patterns.length > 0) {
					assetSettings.run_worker_first = patterns;
				}
			}

			await updateAssetSettings(projectId, assetSettings);
			onOpenChange(false);
		} catch {
			setError('Failed to save settings');
		} finally {
			setIsSaving(false);
		}
	}, [projectId, notFoundHandling, htmlHandling, runWorkerFirstMode, runWorkerFirstPatterns, onOpenChange]);

	return (
		<>
			<ModalBody className="flex h-[460px] flex-col gap-5 overflow-y-auto">
				{displayError && (
					<div className="rounded-md border border-red-500/30 bg-red-500/10 p-2.5">
						<p className="text-xs text-red-500">{displayError}</p>
					</div>
				)}

				{/* Not Found Handling */}
				<fieldset className="flex flex-col gap-2">
					<legend className="text-xs font-medium text-text-secondary">Not Found Handling</legend>
					<p className="text-xs text-text-secondary/70">Controls what happens when a request doesn't match any static asset.</p>
					<div className="flex flex-col gap-1.5">
						{NOT_FOUND_HANDLING_OPTIONS.map((option) => (
							<label
								key={option.value}
								className={cn(
									`
										flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
										transition-colors
									`,
									notFoundHandling === option.value ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
								)}
								htmlFor={`nfh-${option.value}`}
							>
								<input
									id={`nfh-${option.value}`}
									type="radio"
									name="not-found-handling"
									value={option.value}
									checked={notFoundHandling === option.value}
									onChange={() => setNotFoundHandling(option.value)}
									className="mt-0.5 accent-accent"
								/>
								<div className="flex flex-col gap-0.5">
									<span className="text-xs font-medium text-text-primary">{option.label}</span>
									<span className="text-xs text-text-secondary/70">{option.description}</span>
								</div>
							</label>
						))}
					</div>
				</fieldset>

				{/* HTML Handling */}
				<fieldset className="flex flex-col gap-2">
					<legend className="text-xs font-medium text-text-secondary">HTML Handling</legend>
					<p className="text-xs text-text-secondary/70">Controls trailing slash behavior for HTML page requests.</p>
					<select
						value={htmlHandling}
						onChange={(event) => setHtmlHandling(parseHtmlHandling(event.target.value))}
						className={INPUT_CLASSES}
						aria-label="HTML handling mode"
					>
						{HTML_HANDLING_OPTIONS.map((option) => (
							<option key={option.value} value={option.value}>
								{option.label}
							</option>
						))}
					</select>
					<p className="text-xs text-text-secondary/70">{HTML_HANDLING_OPTIONS.find((o) => o.value === htmlHandling)?.description}</p>
				</fieldset>

				{/* Run Worker First */}
				<fieldset className="flex flex-col gap-2">
					<legend className="text-xs font-medium text-text-secondary">Run Worker First</legend>
					<p className="text-xs text-text-secondary/70">Controls whether the Worker script runs before serving static assets.</p>
					<div className="flex flex-col gap-1.5">
						<label
							className={cn(
								`
									flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								runWorkerFirstMode === 'off' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="rwf-off"
						>
							<input
								id="rwf-off"
								type="radio"
								name="run-worker-first"
								value="off"
								checked={runWorkerFirstMode === 'off'}
								onChange={() => setRunWorkerFirstMode('off')}
								className="mt-0.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span className="text-xs font-medium text-text-primary">Off</span>
								<span className="text-xs text-text-secondary/70">Serve static assets first (default)</span>
							</div>
						</label>
						<label
							className={cn(
								`
									flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								runWorkerFirstMode === 'all' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="rwf-all"
						>
							<input
								id="rwf-all"
								type="radio"
								name="run-worker-first"
								value="all"
								checked={runWorkerFirstMode === 'all'}
								onChange={() => setRunWorkerFirstMode('all')}
								className="mt-0.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span className="text-xs font-medium text-text-primary">All Requests</span>
								<span className="text-xs text-text-secondary/70">Always run the Worker before serving assets</span>
							</div>
						</label>
						<label
							className={cn(
								`
									flex cursor-pointer items-start gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								runWorkerFirstMode === 'patterns' ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="rwf-patterns"
						>
							<input
								id="rwf-patterns"
								type="radio"
								name="run-worker-first"
								value="patterns"
								checked={runWorkerFirstMode === 'patterns'}
								onChange={() => setRunWorkerFirstMode('patterns')}
								className="mt-0.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span className="text-xs font-medium text-text-primary">Specific Routes</span>
								<span className="text-xs text-text-secondary/70">Run the Worker first only for matching route patterns</span>
							</div>
						</label>
					</div>
					{runWorkerFirstMode === 'patterns' && (
						<div className="flex flex-col gap-1.5">
							<textarea
								value={runWorkerFirstPatterns}
								onChange={(event) => setRunWorkerFirstPatterns(event.target.value)}
								placeholder={'/api/*\n!/api/docs/*'}
								rows={3}
								className={cn(
									`
										resize-y rounded-sm border border-border bg-bg-primary px-2.5 py-2
										font-mono text-xs text-text-primary
									`,
									'placeholder:text-text-secondary/50',
									'focus:border-accent focus:outline-none',
								)}
								aria-label="Route patterns (one per line)"
							/>
							<p className="text-xs text-text-secondary/70">One pattern per line. Use * for wildcards. Prefix with ! to exclude.</p>
						</div>
					)}
				</fieldset>
			</ModalBody>
			<ModalFooter>
				<Button variant="secondary" onClick={() => onOpenChange(false)} disabled={isSaving}>
					Cancel
				</Button>
				<Button onClick={handleSave} disabled={isSaving} isLoading={isSaving} loadingText="Saving...">
					Save Settings
				</Button>
			</ModalFooter>
		</>
	);
}
