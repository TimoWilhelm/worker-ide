/**
 * Test File Item
 *
 * A single test file row in the tests panel.
 * Shows file path, status indicator, and expandable test list.
 * Tests are shown from discovery data (before execution) or from
 * execution results (after running), with per-test play buttons.
 *
 * Uses flat depth-based indentation (like the file tree) rather than
 * nested margin/padding, so the layout stays clean at any panel width.
 *
 * Visual hierarchy:
 *   depth 0  —  File row      (chevron · status · file-icon · path · count · play)
 *   depth 1  —  Suite row     (chevron · status · suite name · play)
 *   depth 1  —  Top-level test (status · test name · play)
 *   depth 2  —  Nested test    (status · test name · play)
 */

import { CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, File, Loader2, Play, XCircle } from 'lucide-react';
import { useState } from 'react';

import { cn } from '@/lib/utils';

import type { DiscoveredTest, TestFileResult } from '@shared/types';

// =============================================================================
// Constants
// =============================================================================

/** Pixels of indentation per depth level */
const INDENT_PX = 12;
/** Base left padding (depth 0) */
const BASE_PAD_PX = 8;

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

/** Normalized test row used for both discovered and executed tests */
interface TestRowData {
	key: string;
	/** Display name (test name only, without suite prefix) */
	name: string;
	/** Full label including suite prefix for running individual tests */
	fullLabel: string;
	status?: 'passed' | 'failed';
	error?: string;
	line?: number;
}

/** A group of tests belonging to the same describe block (suite) */
interface TestSuiteGroup {
	suiteName: string;
	tests: TestRowData[];
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
			const fullLabel = test.suiteName === '(top-level)' ? test.name : `${test.suiteName} > ${test.name}`;
			const executed = executedTests.get(key);
			return { key, name: test.name, fullLabel, status: executed?.status, error: executed?.error, line: test.line };
		});
	}

	// Fallback: if there are no discovered tests but we have execution results,
	// show them directly (e.g., tests created at runtime).
	if (fileResult && fileResult.results.suites.length > 0) {
		const rows: TestRowData[] = [];
		for (const suite of fileResult.results.suites) {
			for (const test of suite.tests) {
				const fullLabel = suite.name === '(top-level)' ? test.name : `${suite.name} > ${test.name}`;
				rows.push({ key: `${suite.name}/${test.name}`, name: test.name, fullLabel, status: test.status, error: test.error });
			}
		}
		return rows;
	}

	return [];
}

/**
 * Group test rows by their suite name, preserving insertion order.
 * Top-level tests (suiteName === "(top-level)") are kept as a group
 * with an empty string suite name so they render without a header.
 */
function buildSuiteGroups(rows: TestRowData[]): TestSuiteGroup[] {
	const groupMap = new Map<string, TestRowData[]>();
	const groupOrder: string[] = [];

	for (const row of rows) {
		// Extract suite name from the key (format: "suiteName/testName")
		const slashIndex = row.key.indexOf('/');
		const suiteName = slashIndex === -1 ? '(top-level)' : row.key.slice(0, slashIndex);
		const normalizedSuite = suiteName === '(top-level)' ? '' : suiteName;

		const existing = groupMap.get(normalizedSuite);
		if (existing) {
			existing.push(row);
		} else {
			groupMap.set(normalizedSuite, [row]);
			groupOrder.push(normalizedSuite);
		}
	}

	return groupOrder.map((suiteName) => ({
		suiteName,

		tests: groupMap.get(suiteName)!,
	}));
}

/** Derive an aggregate pass/fail status for a suite from its test rows */
function getSuiteStatus(tests: TestRowData[]): 'idle' | 'passed' | 'failed' {
	let hasPassed = false;
	let hasFailed = false;
	for (const test of tests) {
		if (test.status === 'failed') hasFailed = true;
		if (test.status === 'passed') hasPassed = true;
	}
	if (hasFailed) return 'failed';
	if (hasPassed) return 'passed';
	return 'idle';
}

function paddingForDepth(depth: number) {
	return `${depth * INDENT_PX + BASE_PAD_PX}px`;
}

// =============================================================================
// Icon Components
// =============================================================================

function StatusIcon({ status }: { status: TestFileStatus }) {
	switch (status) {
		case 'idle': {
			return <Circle className="size-3.5 shrink-0 text-text-secondary" />;
		}
		case 'running': {
			return <Loader2 className="size-3.5 shrink-0 animate-spin text-text-secondary" />;
		}
		case 'passed': {
			return <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />;
		}
		case 'partial-passed': {
			return <CircleDashed className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />;
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
		return <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />;
	}
	if (status === 'failed') {
		return (
			<XCircle
				className="
					size-3.5 shrink-0 text-red-600
					dark:text-red-400
				"
			/>
		);
	}
	return <Circle className="size-3.5 shrink-0 text-text-secondary" />;
}

// =============================================================================
// Play Button (shared by files, suites, and tests)
// =============================================================================

interface PlayButtonProperties {
	isRunning: boolean;
	onClick: (event: React.MouseEvent) => void;
	/** If true, always visible (file/suite level). If false, show-on-hover (tests). */
	alwaysVisible?: boolean;
	groupHoverClass?: string;
}

function PlayButton({ isRunning, onClick, alwaysVisible, groupHoverClass = 'group-hover/row:opacity-100' }: PlayButtonProperties) {
	return (
		<button
			className={cn(
				'flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm',
				'text-text-secondary transition-colors',
				!isRunning &&
					!alwaysVisible &&
					`
						opacity-0
						${groupHoverClass}
					`,
				!isRunning && 'hover:bg-bg-tertiary hover:text-text-primary',
				isRunning && 'pointer-events-none invisible',
			)}
			onClick={(event) => {
				event.stopPropagation();
				if (!isRunning) onClick(event);
			}}
		>
			<Play className="size-3" />
		</button>
	);
}

// =============================================================================
// Suite Group
// =============================================================================

interface SuiteGroupViewProperties {
	group: TestSuiteGroup;
	filePath: string;
	isRunning: boolean;
	onOpenTest?: (path: string, line: number) => void;
	onRunFile?: (path: string) => void;
	onRunTest?: (filePath: string, testName: string) => void;
}

function SuiteGroupView({ group, filePath, isRunning, onOpenTest, onRunFile, onRunTest }: SuiteGroupViewProperties) {
	const hasSuiteName = group.suiteName.length > 0;
	const [suiteExpanded, setSuiteExpanded] = useState(true);
	const suiteStatus = getSuiteStatus(group.tests);

	// Top-level tests (no describe block) render at depth 1 without a suite header
	if (!hasSuiteName) {
		return (
			<>
				{group.tests.map((row) => (
					<TestRow
						key={row.key}
						row={row}
						depth={1}
						filePath={filePath}
						isRunning={isRunning}
						onOpenTest={onOpenTest}
						onRunTest={onRunTest}
					/>
				))}
			</>
		);
	}

	return (
		<>
			{/* Suite header row — same structure as file row: depth-based padding, full-width hover */}
			<div
				className="
					group/row flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pr-2
					text-xs transition-colors select-none
					hover:bg-bg-tertiary
				"
				style={{ paddingLeft: paddingForDepth(1) }}
				onClick={() => setSuiteExpanded(!suiteExpanded)}
			>
				{/* Chevron */}
				<span
					className="
						flex size-4 shrink-0 items-center justify-center text-text-secondary
					"
				>
					{suiteExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				</span>

				{/* Status icon */}
				{suiteStatus === 'passed' && <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />}
				{suiteStatus === 'failed' && <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
				{suiteStatus === 'idle' && <Circle className="size-3.5 shrink-0 text-text-secondary" />}

				{/* Suite name */}
				<span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={group.suiteName}>
					{group.suiteName}
				</span>

				{/* Run suite (runs entire file) */}
				{onRunFile && <PlayButton isRunning={isRunning} onClick={() => onRunFile(filePath)} />}
			</div>

			{/* Nested tests at depth 2 */}
			{suiteExpanded &&
				group.tests.map((row) => (
					<TestRow
						key={row.key}
						row={row}
						depth={2}
						filePath={filePath}
						isRunning={isRunning}
						onOpenTest={onOpenTest}
						onRunTest={onRunTest}
					/>
				))}
		</>
	);
}

// =============================================================================
// Test Row
// =============================================================================

interface TestRowProperties {
	row: TestRowData;
	depth: number;
	filePath: string;
	isRunning: boolean;
	onOpenTest?: (path: string, line: number) => void;
	onRunTest?: (filePath: string, testName: string) => void;
}

function TestRow({ row, depth, filePath, isRunning, onOpenTest, onRunTest }: TestRowProperties) {
	return (
		<div
			className={cn(
				`
					group/row flex min-w-0 items-center gap-1.5 py-0.5 pr-2 text-xs
					transition-colors select-none
				`,
				row.line &&
					onOpenTest &&
					`
						cursor-pointer
						hover:bg-bg-tertiary
					`,
			)}
			style={{ paddingLeft: paddingForDepth(depth) }}
			onClick={() => {
				if (row.line && onOpenTest) {
					onOpenTest(`/${filePath}`, row.line);
				}
			}}
		>
			{/* Spacer — aligns with the chevron column of parent rows */}
			<span className="size-4 shrink-0" />

			{/* Status icon */}
			<TestStatusIcon status={row.status} />

			{/* Test name */}
			<div className="min-w-0 flex-1">
				<span className="block truncate text-text-secondary" title={row.name}>
					{row.name}
				</span>
				{row.error && (
					<span
						className="
							block truncate text-red-600
							dark:text-red-400
						"
						title={row.error}
					>
						{row.error}
					</span>
				)}
			</div>

			{/* Run single test */}
			{onRunTest && <PlayButton isRunning={isRunning} onClick={() => onRunTest(filePath, row.fullLabel)} />}
		</div>
	);
}

// =============================================================================
// Main Component
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
		<div className="min-w-0">
			{/* File row */}
			<div
				className={cn(
					`
						group/row flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pr-2
						text-sm transition-colors select-none
					`,
					'hover:bg-bg-tertiary',
				)}
				style={{ paddingLeft: paddingForDepth(0) }}
				onClick={() => {
					onOpenFile?.(`/${filePath}`);
					if (canExpand) {
						setExpanded(true);
					}
				}}
			>
				{/* Chevron */}
				{canExpand ? (
					<button
						className="
							flex size-4 shrink-0 cursor-pointer items-center justify-center
							rounded-sm text-text-secondary transition-colors
							hover:text-text-primary
						"
						onClick={(event) => {
							event.stopPropagation();
							setExpanded(!expanded);
						}}
					>
						{expanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
					</button>
				) : (
					<span className="size-4 shrink-0" />
				)}

				{/* Status icon */}
				<StatusIcon status={status} />

				{/* File icon */}
				<File className="size-3.5 shrink-0 text-text-secondary" />

				{/* File path */}
				<span className="min-w-0 flex-1 truncate text-text-primary" title={filePath}>
					{filePath}
				</span>

				{/* Counts badge */}
				{fileResult && (
					<span className={cn('shrink-0 text-xs text-text-secondary tabular-nums', status === 'running' && 'invisible')}>
						{fileResult.results.passed}/
						{discoveredTests ? Math.max(discoveredTests.length, fileResult.results.total) : fileResult.results.total}
					</span>
				)}

				{/* Run file */}
				{onRunFile && <PlayButton isRunning={isRunning} onClick={() => onRunFile(filePath)} />}
			</div>

			{/* Expanded children */}
			{expanded && canExpand && (
				<>
					{/* Runtime error (not per-test) */}
					{fileResult?.results.error && (
						<div
							className="
								py-1 pr-2 text-xs text-red-600
								dark:text-red-400
							"
							style={{ paddingLeft: paddingForDepth(1) }}
						>
							{fileResult.results.error}
						</div>
					)}

					{/* Suite groups */}
					{buildSuiteGroups(testRows).map((group) => (
						<SuiteGroupView
							key={group.suiteName || '__top-level__'}
							group={group}
							filePath={filePath}
							isRunning={isRunning}
							onOpenTest={onOpenTest}
							onRunFile={onRunFile}
							onRunTest={onRunTest}
						/>
					))}
				</>
			)}
		</div>
	);
}
