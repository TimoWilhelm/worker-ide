/**
 * Test File Item
 *
 * A single test file row in the tests panel.
 * Shows file path, status indicator, and expandable test list.
 * Tests are shown from discovery data (before execution) or from
 * execution results (after running), with per-test play buttons.
 */

import { CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, File, Loader2, Play, XCircle } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import type { DiscoveredTest, TestFileResult } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

type TestFileStatus = 'idle' | 'running' | 'passed' | 'failed' | 'partial-passed';

interface TestFileItemProperties {
	/** Relative file path (e.g., "test/math.test.ts") */
	filePath: string;
	/** Statically discovered tests (from parsing, available before execution) */
	discoveredTests?: DiscoveredTest[];
	/** Test results for this file (undefined if not yet run) */
	fileResult?: TestFileResult;
	/** Whether this file's tests are currently running */
	isRunning?: boolean;
	/** Called when the user clicks to open the file in the editor */
	onOpenFile?: (path: string) => void;
	/** Called when the user clicks a test to navigate to its line in the source */
	onOpenTest?: (path: string, line: number) => void;
	/** Called when the user clicks the play button to run this single file */
	onRunFile?: (path: string) => void;
	/** Called when the user clicks the play button on an individual test */
	onRunTest?: (filePath: string, testName: string) => void;
}

/** Normalized test row �� used for both discovered and executed tests */
interface TestRowData {
	key: string;
	label: string;
	status?: 'passed' | 'failed';
	error?: string;
	line?: number;
}

// =============================================================================
// Helpers
// =============================================================================

function getFileStatus(
	fileResult: TestFileResult | undefined,
	isRunning: boolean,
	discoveredTests: DiscoveredTest[] | undefined,
): TestFileStatus {
	if (isRunning) return 'running';
	if (!fileResult) return 'idle';

	if (fileResult.results.error || fileResult.results.failed > 0) return 'failed';

	const isPartial = discoveredTests !== undefined && discoveredTests.length > 0 && fileResult.results.total < discoveredTests.length;
	return isPartial ? 'partial-passed' : 'passed';
}

/**
 * Build a normalized list of test rows by merging discovery data with execution
 * results.  Discovery provides the full set of tests (even before any run);
 * execution results overlay pass/fail status on the tests that have been run.
 * This ensures that running a single test never hides the other tests — they
 * remain visible with an "idle" (no status) indicator.
 */
function buildTestRows(fileResult: TestFileResult | undefined, discoveredTests: DiscoveredTest[] | undefined): TestRowData[] {
	// Build a lookup of execution results keyed by "suiteName/testName"
	const executedTests = new Map<string, { status: 'passed' | 'failed'; error?: string }>();
	if (fileResult) {
		for (const suite of fileResult.results.suites) {
			for (const test of suite.tests) {
				executedTests.set(`${suite.name}/${test.name}`, { status: test.status, error: test.error });
			}
		}
	}

	// Start from discovered tests so we always show the full set
	if (discoveredTests && discoveredTests.length > 0) {
		return discoveredTests.map((test) => {
			const key = `${test.suiteName}/${test.name}`;
			const label = test.suiteName === '(top-level)' ? test.name : `${test.suiteName} > ${test.name}`;
			const executed = executedTests.get(key);
			return { key, label, status: executed?.status, error: executed?.error, line: test.line };
		});
	}

	// Fallback: if there are no discovered tests but we have execution results,
	// show them directly (e.g., tests created at runtime).
	if (fileResult && fileResult.results.suites.length > 0) {
		const rows: TestRowData[] = [];
		for (const suite of fileResult.results.suites) {
			for (const test of suite.tests) {
				const label = suite.name === '(top-level)' ? test.name : `${suite.name} > ${test.name}`;
				rows.push({ key: `${suite.name}/${test.name}`, label, status: test.status, error: test.error });
			}
		}
		return rows;
	}

	return [];
}

function StatusIcon({ status }: { status: TestFileStatus }) {
	switch (status) {
		case 'idle': {
			return <Circle className="size-3.5 shrink-0 text-text-secondary" />;
		}
		case 'running': {
			return <Loader2 className="size-3.5 shrink-0 animate-spin text-text-secondary" />;
		}
		case 'passed': {
			return (
				<CheckCircle2
					className="
						size-3.5 shrink-0 text-green-600
						dark:text-green-400
					"
				/>
			);
		}
		case 'partial-passed': {
			return (
				<CircleDashed
					className="
						size-3.5 shrink-0 text-green-600
						dark:text-green-400
					"
				/>
			);
		}
		case 'failed': {
			return (
				<XCircle
					className="
						size-3.5 shrink-0 text-red-600
						dark:text-red-400
					"
				/>
			);
		}
	}
}

function TestStatusIcon({ status }: { status?: 'passed' | 'failed' }) {
	if (status === 'passed') {
		return <CheckCircle2 className="mt-0.5 size-3 shrink-0 text-green-600 dark:text-green-400" />;
	}
	if (status === 'failed') {
		return <XCircle className="mt-0.5 size-3 shrink-0 text-red-600 dark:text-red-400" />;
	}
	return <Circle className="mt-0.5 size-3 shrink-0 text-text-secondary" />;
}

// =============================================================================
// Component
// =============================================================================

export function TestFileItem({
	filePath,
	discoveredTests,
	fileResult,
	isRunning = false,
	onOpenFile,
	onOpenTest,
	onRunFile,
	onRunTest,
}: TestFileItemProperties) {
	const [expanded, setExpanded] = useState(false);
	const status = getFileStatus(fileResult, isRunning, discoveredTests);
	const testRows = buildTestRows(fileResult, discoveredTests);
	const canExpand = testRows.length > 0;

	return (
		<div className="text-sm">
			{/* File row */}
			<div
				className={cn('group flex cursor-pointer items-center gap-1.5 px-2 py-1', 'transition-colors hover:bg-bg-tertiary')}
				onClick={() => {
					onOpenFile?.(`/${filePath}`);
					if (canExpand) {
						setExpanded(true);
					}
				}}
			>
				{/* Expand chevron */}
				{canExpand ? (
					<button
						className={cn(
							'flex size-5 shrink-0 cursor-pointer items-center justify-center',
							'rounded-sm text-text-secondary transition-colors',
							'hover:bg-bg-tertiary hover:text-text-primary',
						)}
						onClick={(event) => {
							event.stopPropagation();
							setExpanded(!expanded);
						}}
					>
						{expanded ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
					</button>
				) : (
					<span className="size-4 shrink-0" />
				)}

				{/* Status icon */}
				<StatusIcon status={status} />

				{/* File icon */}
				<File className="size-3.5 shrink-0 text-text-secondary" />

				{/* File path */}
				<span className="min-w-0 truncate text-text-primary">{filePath}</span>

				{/* Counts badge */}
				{fileResult && (
					<span className={cn('ml-auto shrink-0 text-xs text-text-secondary', status === 'running' && 'invisible')}>
						{fileResult.results.passed}/
						{discoveredTests ? Math.max(discoveredTests.length, fileResult.results.total) : fileResult.results.total}
					</span>
				)}

				{/* Run single file button */}
				{onRunFile && (
					<button
						className={cn(
							'flex size-5 shrink-0 cursor-pointer items-center justify-center',
							'rounded-sm text-text-secondary transition-colors',
							!isRunning &&
								`
									opacity-0
									group-hover:opacity-100
								`,
							!isRunning && 'hover:bg-bg-tertiary hover:text-text-primary',
							isRunning && 'invisible',
							!fileResult && 'ml-auto',
						)}
						onClick={(event) => {
							if (isRunning) return;
							event.stopPropagation();
							onRunFile(filePath);
						}}
					>
						<Play className="size-3" />
					</button>
				)}
			</div>

			{/* Expanded details — individual tests */}
			{expanded && canExpand && (
				<div className="ml-5 border-l border-border pl-2">
					{/* Runtime error (not per-test) */}
					{fileResult?.results.error && <div className="py-1 text-xs text-red-600 dark:text-red-400">{fileResult.results.error}</div>}

					{/* Test rows */}
					{testRows.map((row) => (
						<div
							key={row.key}
							className={cn(
								'group/test flex items-start gap-1.5 px-1 py-0.5',
								row.line && onOpenTest && 'cursor-pointer rounded-sm hover:bg-bg-tertiary',
							)}
							onClick={() => {
								if (row.line && onOpenTest) {
									onOpenTest(`/${filePath}`, row.line);
								}
							}}
						>
							<TestStatusIcon status={row.status} />
							<div className="min-w-0 flex-1">
								<span className="text-xs text-text-primary">{row.label}</span>
								{row.error && <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">{row.error}</div>}
							</div>
							{/* Run single test button */}
							{onRunTest && (
								<button
									className={cn(
										`
											flex size-5 shrink-0 cursor-pointer items-center justify-center
											rounded-sm
										`,
										'text-text-secondary transition-colors',
										!isRunning &&
											`
												opacity-0
												group-hover/test:opacity-100
											`,
										!isRunning && 'hover:bg-bg-tertiary hover:text-text-primary',
										isRunning && 'invisible',
									)}
									onClick={(event) => {
										if (isRunning) return;
										event.stopPropagation();
										onRunTest(filePath, row.label);
									}}
								>
									<Play className="size-3" />
								</button>
							)}
						</div>
					))}
				</div>
			)}
		</div>
	);
}
