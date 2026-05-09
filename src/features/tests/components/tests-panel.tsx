import { ScrollArea } from '@base-ui/react/scroll-area';
import { CheckCircle2, FlaskConical, Play, RefreshCw, XCircle } from 'lucide-react';
import { useMemo } from 'react';

import { Button } from '@/components/ui/button';
import { ListSkeleton } from '@/components/ui/skeleton';
import { Tooltip } from '@/components/ui/tooltip';
import { useFileTargetOpener } from '@/lib/file-target';
import { cn } from '@/lib/utils';

import { TestFileItem } from './test-file-item';
import { useRunTests, useTestDiscovery, useTestResults } from '../hooks/use-test-run';

import type { TestFileResult, TestRunResponse } from '@shared/types';

interface TestsPanelProperties {
	projectId: string;
	className?: string;
}

function buildResultsMap(results: TestRunResponse | undefined): Map<string, TestFileResult> {
	const map = new Map<string, TestFileResult>();
	if (!results) return map;
	for (const fileResult of results.fileResults) {
		map.set(fileResult.file, fileResult);
	}
	return map;
}

export function TestsPanel({ projectId, className }: TestsPanelProperties) {
	const openFileTarget = useFileTargetOpener();
	const { discoveredFiles, isLoading: isLoadingFiles, isRefreshing, refresh: refreshFiles } = useTestDiscovery({ projectId });
	const { results } = useTestResults({ projectId });
	const { runTests, isRunning, error, openTestFile } = useRunTests({ projectId });

	const resultsMap = useMemo(() => buildResultsMap(results), [results]);

	const hasResults = results !== undefined;
	const hasTestFiles = discoveredFiles.length > 0;

	return (
		<div className={cn('flex h-full min-w-0 flex-col overflow-hidden', className)}>
			<div className="flex shrink-0 items-center gap-1.5 border-b border-border p-2">
				<FlaskConical className="size-4 text-text-secondary" />
				<span
					className="
						text-xs font-semibold tracking-wider text-text-secondary uppercase
					"
				>
					Tests
				</span>

				<span className="flex-1" />

				<Tooltip content="Refresh test files">
					<button
						className={cn(
							`
								flex size-6 cursor-pointer items-center justify-center rounded-sm
								text-text-secondary transition-colors
							`,
							isRefreshing ? 'cursor-default opacity-60' : 'hover:bg-bg-tertiary hover:text-text-primary',
						)}
						onClick={refreshFiles}
						disabled={isRefreshing}
					>
						<RefreshCw className={cn('size-3.5', isRefreshing && 'animate-spin')} />
					</button>
				</Tooltip>

				<Tooltip content="Run all tests">
					<Button
						variant="ghost"
						size="sm"
						className={cn('h-6 gap-1 px-2 text-xs transition-colors', 'hover:bg-bg-tertiary hover:text-text-primary')}
						onClick={() => runTests()}
						disabled={!hasTestFiles}
						isLoading={isRunning}
					>
						<Play className="size-3" />
						Run
					</Button>
				</Tooltip>
			</div>

			{hasResults && results && (
				<div
					className={cn(
						`
							flex flex-wrap items-center gap-x-2 gap-y-0.5 border-b border-border px-2
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

			{error && (
				<div
					className="
						shrink-0 border-b border-border bg-red-50 px-2 py-1.5 text-xs text-red-700
						dark:bg-red-950/30 dark:text-red-400
					"
				>
					{error.message}
				</div>
			)}

			{isLoadingFiles ? (
				<div className="p-3">
					<ListSkeleton itemCount={4} showLeadingIcon={false} />
				</div>
			) : hasTestFiles ? (
				<ScrollArea.Root className="h-full flex-1 overflow-hidden">
					<ScrollArea.Viewport className="size-full">
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
										openFileTarget({ path, position: { line, column: 1 } });
									}}
									onRunFile={(path) => runTests({ pattern: path })}
									onRunTest={(filePath, testName) => runTests({ pattern: filePath, testName })}
								/>
							))}

							{results && results.bundleErrors.length > 0 && (
								<div className="mt-2 border-t border-border p-2">
									<div
										className="
											text-xs font-medium text-red-600
											dark:text-red-400
										"
									>
										Bundle Errors
									</div>
									{results.bundleErrors.map(({ file, error: bundleError }) => (
										<div key={file} className="mt-1 min-w-0 truncate text-xs text-text-secondary" title={`${file}: ${bundleError}`}>
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
