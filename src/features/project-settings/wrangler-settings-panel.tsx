/**
 * Wrangler Settings Panel
 *
 * Inline settings form rendered in the editor area when wrangler.jsonc is the active file.
 * Controls Cloudflare Workers asset routing settings and IDE-managed bindings.
 */

import { useQuery, useSuspenseQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, FileJson2, Save } from 'lucide-react';
import { Suspense, useCallback, useEffect, useRef, useState } from 'react';

import { ErrorBoundary } from '@/components/error-boundary';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { fetchProjectMeta, fetchStorageUsage, updateProjectMeta } from '@/lib/api-client';
import { cn } from '@/lib/utils';

import type { AssetSettings, HtmlHandling, NotFoundHandling } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface WranglerSettingsPanelProperties {
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

function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / 1024 ** exponent;
	return `${value % 1 === 0 ? value : value.toFixed(1)} ${units[exponent]}`;
}

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
// Error Fallback
// =============================================================================

function SettingsErrorFallback({ resetErrorBoundary }: { error: Error; resetErrorBoundary: () => void }) {
	return (
		<div className="flex h-full flex-col items-center justify-center gap-3">
			<p className="text-sm text-text-secondary">Could not load wrangler settings.</p>
			<Button variant="outline" size="sm" onClick={resetErrorBoundary}>
				Retry
			</Button>
		</div>
	);
}

// =============================================================================
// Component
// =============================================================================

export function WranglerSettingsPanel({ projectId }: WranglerSettingsPanelProperties) {
	return (
		<ErrorBoundary fallback={SettingsErrorFallback}>
			<Suspense
				fallback={
					<div className="flex h-full items-center justify-center">
						<Spinner size="md" />
					</div>
				}
			>
				<WranglerSettingsContent projectId={projectId} />
			</Suspense>
		</ErrorBoundary>
	);
}

function WranglerSettingsContent({ projectId }: { projectId: string }) {
	const queryClient = useQueryClient();
	const [isSaving, setIsSaving] = useState(false);
	const [error, setError] = useState<string | undefined>();
	const [savedMessage, setSavedMessage] = useState(false);
	const savedTimerReference = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

	// Clear saved-message timer on unmount
	useEffect(() => () => clearTimeout(savedTimerReference.current), []);

	const settingsQuery = useSuspenseQuery({
		queryKey: ['project-settings', projectId],
		queryFn: () => fetchProjectMeta(projectId),
		staleTime: 0,
	});
	const loadedSettings = settingsQuery.data.assetSettings;
	const loadedBindings = settingsQuery.data.bindingsConfig;

	const [notFoundHandling, setNotFoundHandling] = useState<NotFoundHandling>(() => loadedSettings?.not_found_handling ?? 'none');
	const [htmlHandling, setHtmlHandling] = useState<HtmlHandling>(() => loadedSettings?.html_handling ?? 'auto-trailing-slash');
	const [runWorkerFirstMode, setRunWorkerFirstMode] = useState<RunWorkerFirstMode>(() =>
		getRunWorkerFirstMode(loadedSettings?.run_worker_first),
	);
	const [runWorkerFirstPatterns, setRunWorkerFirstPatterns] = useState(() => getRunWorkerFirstPatterns(loadedSettings?.run_worker_first));
	const [storageEnabled, setStorageEnabled] = useState(() => loadedBindings?.storage ?? false);

	// Sync form state when the query refetches (e.g. after save + invalidation)
	useEffect(() => {
		setNotFoundHandling(loadedSettings?.not_found_handling ?? 'none');
		setHtmlHandling(loadedSettings?.html_handling ?? 'auto-trailing-slash');
		setRunWorkerFirstMode(getRunWorkerFirstMode(loadedSettings?.run_worker_first));
		setRunWorkerFirstPatterns(getRunWorkerFirstPatterns(loadedSettings?.run_worker_first));
	}, [loadedSettings]);

	useEffect(() => {
		setStorageEnabled(loadedBindings?.storage ?? false);
	}, [loadedBindings]);

	const handleSave = useCallback(async () => {
		setIsSaving(true);
		setError(undefined);
		setSavedMessage(false);

		try {
			const assetSettings: AssetSettings = {};

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

			await updateProjectMeta(projectId, { assetSettings, bindingsConfig: { storage: storageEnabled || undefined } });
			await queryClient.invalidateQueries({ queryKey: ['project-settings', projectId] });
			setSavedMessage(true);
			clearTimeout(savedTimerReference.current);
			savedTimerReference.current = setTimeout(() => setSavedMessage(false), 2000);
		} catch (error_) {
			const message = error_ instanceof Error ? error_.message : 'Failed to save settings';
			setError(message);
		} finally {
			setIsSaving(false);
		}
	}, [projectId, notFoundHandling, htmlHandling, runWorkerFirstMode, runWorkerFirstPatterns, storageEnabled, queryClient]);

	return (
		<div className="flex h-full flex-col overflow-hidden">
			{/* Header */}
			<div
				className="
					flex shrink-0 items-center justify-between border-b border-border
					bg-bg-secondary px-4 py-2.5
				"
			>
				<div className="flex items-center gap-2">
					<FileJson2 className="size-4 text-accent" />
					<span className="text-sm font-medium text-text-primary">Wrangler Configuration</span>
				</div>
				<div className="flex items-center gap-2">
					{savedMessage && <span className="text-xs text-green-500">Saved</span>}
					<Button size="sm" onClick={handleSave} disabled={isSaving} isLoading={isSaving} loadingText="Saving...">
						<Save className="mr-1 size-3" />
						Save
					</Button>
				</div>
			</div>

			{/* Settings form */}
			<div className="flex-1 overflow-y-auto p-4">
				<div className="mx-auto flex max-w-lg flex-col gap-6">
					{error && (
						<div className="rounded-md border border-red-500/30 bg-red-500/10 p-2.5">
							<p className="text-xs text-red-500">{error}</p>
						</div>
					)}

					<h3 className="text-sm font-semibold text-text-primary">Asset Settings</h3>

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
						<div className="relative">
							<select
								value={htmlHandling}
								onChange={(event) => setHtmlHandling(parseHtmlHandling(event.target.value))}
								className={cn(INPUT_CLASSES, 'w-full appearance-none pr-7')}
								aria-label="HTML handling mode"
							>
								{HTML_HANDLING_OPTIONS.map((option) => (
									<option key={option.value} value={option.value}>
										{option.label}
									</option>
								))}
							</select>
							<ChevronDown
								className="
									pointer-events-none absolute top-1/2 right-2 size-3.5 -translate-y-1/2
									text-text-secondary
								"
							/>
						</div>
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

					{/* Bindings */}
					<h3 className="mt-2 text-sm font-semibold text-text-primary">Bindings</h3>

					<fieldset className="flex flex-col gap-2">
						<legend className="text-xs font-medium text-text-secondary">Object Storage (R2)</legend>
						<p className="text-xs text-text-secondary/70">
							Project-scoped object storage binding. Available as{' '}
							<code className="rounded-sm bg-bg-tertiary px-1 font-mono">env.STORAGE</code> in your worker code.
						</p>
						<label
							className={cn(
								`
									flex cursor-pointer items-center gap-2.5 rounded-sm border p-2.5
									transition-colors
								`,
								storageEnabled ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
							)}
							htmlFor="binding-storage"
						>
							<input
								id="binding-storage"
								type="checkbox"
								checked={storageEnabled}
								onChange={(event) => setStorageEnabled(event.target.checked)}
								className="size-3.5 accent-accent"
							/>
							<div className="flex flex-col gap-0.5">
								<span className="text-xs font-medium text-text-primary">Enable Object Storage</span>
								{storageEnabled && <StorageUsageBar projectId={projectId} />}
							</div>
						</label>
					</fieldset>
				</div>
			</div>
		</div>
	);
}

function StorageUsageBar({ projectId }: { projectId: string }) {
	const storageQuery = useQuery({
		queryKey: ['storage-usage', projectId],
		queryFn: () => fetchStorageUsage(projectId),
		staleTime: 30_000,
	});

	if (storageQuery.isLoading) {
		return <p className="text-xs text-text-secondary/70">Loading storage usage...</p>;
	}

	const { usageBytes, quotaBytes } = storageQuery.data ?? { usageBytes: 0, quotaBytes: 0 };
	const percentage = quotaBytes > 0 ? Math.min((usageBytes / quotaBytes) * 100, 100) : 0;
	const isNearLimit = percentage > 80;

	return (
		<div className="flex flex-col gap-1">
			<div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-tertiary">
				<div
					className={cn('h-full rounded-full transition-all', isNearLimit ? 'bg-red-400' : 'bg-accent')}
					style={{ width: `${percentage}%` }}
				/>
			</div>
			<span className={cn('font-mono text-xs', isNearLimit ? 'text-red-400' : 'text-text-secondary/70')}>
				{formatBytes(usageBytes)} / {formatBytes(quotaBytes)}
			</span>
		</div>
	);
}
