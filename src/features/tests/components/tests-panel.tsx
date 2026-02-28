/**
 * Tests Panel
 *
 * Sidebar panel for discovering and running project tests.
 * Shows a list of test files, a "Run All" button, and structured
 * pass/fail results. Results are broadcast to all collaborators
 * via WebSocket so everyone sees the same test state.
 */

import { CheckCircle2, FlaskConical, Play, RefreshCw, XCircle } from 'lucide-react';
import { ScrollArea } from 'radix-ui';
import { useMemo } from 'react';

import { Button, Spinner, Tooltip } from '@/components/ui';
import { useStore } from '@/lib/store';
import { cn } from '@/lib/utils';

import { TestFileItem } from './test-file-item';
import { useRunTests, useTestDiscovery, useTestResults } from '../hooks/use-test-run';

import type { TestFileResult, TestRunResponse } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface TestsPanelProperties {
	projectId: string;
	className?: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Build a lookup map from file path to test results */
function buildResultsMap(results: TestRunResponse | undefined): Map<string, TestFileResult> {
	const map = new Map<string, TestFileResult>();
	if (!results) return map;
	for (const fileResult of results.fileResults) {
		map.set(fileResult.file, fileResult);
	}
	return map;
}

// =============================================================================
// Component
// =============================================================================

export function TestsPanel({ projectId, className }: TestsPanelProperties) {
	const goToFilePosition = useStore((state) => state.goToFilePosition);
	const openFile = useStore((state) => state.openFile);
	const { discoveredFiles, isLoading: isLoadingFiles, isRefreshing, refresh: refreshFiles } = useTestDiscovery({ projectId });
	const { results } = useTestResults({ projectId });
	const { runTests, isRunning, error, openTestFile } = useRunTests({ projectId });

	const resultsMap = useMemo(() => buildResultsMap(results), [results]);

	const hasResults = results !== undefined;
	const hasTestFiles = discoveredFiles.length > 0;

	return (
		<div className={cn('flex h-full flex-col overflow-hidden', className)}>
			{/* Header */}
			<div
				className="
					flex shrink-0 items-center gap-2 border-b border-border px-3 py-2
				"
			>
				<FlaskConical className="size-4 text-text-secondary" />
				<span
					className="
						text-xs font-semibold tracking-wider text-text-secondary uppercase
					"
				>
					Tests
				</span>

				<span className="flex-1" />

				{/* Refresh button — re-discovers test files */}
				<Tooltip content="Refresh test files">
					<button
						className={cn(
							`
								flex size-6 items-center justify-center rounded-sm text-text-secondary
								transition-colors
							`,
							isRefreshing ? 'cursor-default opacity-60' : 'hover:bg-bg-tertiary hover:text-text-primary',
						)}
						onClick={refreshFiles}
						disabled={isRefreshing}
					>
						<RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
					</button>
				</Tooltip>

				{/* Run All button */}
				<Tooltip content="Run all tests">
					<Button
						variant="ghost"
						size="sm"
						className={cn('h-6 gap-1 px-2 text-xs transition-colors', 'hover:bg-bg-tertiary hover:text-text-primary')}
						onClick={() => runTests()}
						disabled={isRunning || !hasTestFiles}
					>
						{isRunning ? <Spinner size="xs" /> : <Play className="size-3" />}
						Run
					</Button>
				</Tooltip>
			</div>

			{/* Summary bar (when results exist) */}
			{hasResults && results && (
				<div
					className={cn(
						`
							flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-3
							py-1.5
						`,
						'text-xs',
					)}
				>
					{results.metadata.passed > 0 && (
						<span
							className="
								flex items-center gap-1 text-green-600
								dark:text-green-400
							"
						>
							<CheckCircle2 className="size-3" />
							{results.metadata.passed} passed
						</span>
					)}
					{results.metadata.failed > 0 && (
						<span
							className="
								flex items-center gap-1 text-red-600
								dark:text-red-400
							"
						>
							<XCircle className="size-3" />
							{results.metadata.failed} failed
						</span>
					)}
					<span className="text-text-secondary">
						{hasTestFiles ? discoveredFiles.reduce((sum, f) => sum + f.tests.length, 0) : results.metadata.total} total
					</span>
					<span className="ml-auto text-text-secondary">
						{results.metadata.files} file{results.metadata.files === 1 ? '' : 's'}
					</span>
				</div>
			)}

			{/* Error banner */}
			{error && (
				<div
					className="
						shrink-0 border-b border-border bg-red-50 px-3 py-2 text-xs text-red-700
						dark:bg-red-950/30 dark:text-red-400
					"
				>
					{error.message}
				</div>
			)}

			{/* Content area */}
			{isLoadingFiles ? (
				<div className="flex flex-1 items-center justify-center">
					<Spinner className="size-5 text-text-secondary" />
				</div>
			) : hasTestFiles ? (
				<ScrollArea.Root className="h-full flex-1 overflow-hidden">
					<ScrollArea.Viewport className="size-full [&>div]:block! [&>div]:h-full! [&>div]:min-w-0!">
						<div className="py-1">
							{discoveredFiles.map((discovered) => (
								<TestFileItem
									key={discovered.file}
									filePath={discovered.file}
									discoveredTests={discovered.tests}
									fileResult={resultsMap.get(discovered.file)}
									isRunning={isRunning}
									onOpenFile={openTestFile}
									onOpenTest={(path, line) => {
										// Needs both: goToFilePosition to set the target line, and openFile to ensure
										// it becomes the active tab if it's already open but in the background.
										goToFilePosition(path, { line, column: 1 });
										openFile(path);
									}}
									onRunFile={(path) => runTests({ pattern: path })}
									onRunTest={(filePath, testName) => runTests({ pattern: filePath, testName })}
								/>
							))}

							{/* Bundle errors section */}
							{results && results.bundleErrors.length > 0 && (
								<div className="mt-2 border-t border-border px-3 py-2">
									<div
										className="
											text-xs font-medium text-red-600
											dark:text-red-400
										"
									>
										Bundle Errors
									</div>
									{results.bundleErrors.map(({ file, error: bundleError }) => (
										<div key={file} className="mt-1 text-xs text-text-secondary">
											<span className="font-medium">{file}</span>: {bundleError}
										</div>
									))}
								</div>
							)}
						</div>
					</ScrollArea.Viewport>
					<ScrollArea.Scrollbar className="flex w-2 touch-none bg-transparent p-0.5 select-none" orientation="vertical">
						<ScrollArea.Thumb className="relative flex-1 rounded-full bg-border" />
					</ScrollArea.Scrollbar>
				</ScrollArea.Root>
			) : (
				<EmptyState />
			)}
		</div>
	);
}

// =============================================================================
// Empty State
// =============================================================================

function EmptyState() {
	return (
		<div
			className="
				flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center
			"
		>
			<FlaskConical className="size-10 text-text-secondary opacity-40" />
			<div>
				<div className="text-sm font-medium text-text-primary">No test files found</div>
				<p className="mt-1 text-xs text-text-secondary">
					Create test files matching <code className="rounded-sm bg-bg-tertiary px-1 py-0.5">*.test.ts</code> or{' '}
					<code className="rounded-sm bg-bg-tertiary px-1 py-0.5">*.spec.ts</code> to get started.
				</p>
			</div>
		</div>
	);
}
