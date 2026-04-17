import { CheckCircle2, ChevronDown, ChevronRight, Circle, CircleDashed, File, Play, XCircle } from 'lucide-react';
import { useState } from 'react';

import { Spinner } from '@/components/ui/spinner';
import { cn } from '@/lib/utils';

import type { DiscoveredTest, TestFileResult } from '@shared/types';

const INDENT_PX = 8;
const BASE_PAD_PX = 6;

type TestFileStatus = 'idle' | 'running' | 'passed' | 'failed' | 'partial-passed';

interface TestFileItemProperties {
	filePath: string;
	discoveredTests?: DiscoveredTest[];
	fileResult?: TestFileResult;
	isRunning?: boolean;
	onOpenFile?: (path: string) => void;
	onOpenTest?: (path: string, line: number) => void;
	onRunFile?: (path: string) => void;
	onRunTest?: (filePath: string, testName: string) => void;
}

interface TestRowData {
	key: string;
	name: string;
	fullLabel: string;
	status?: 'passed' | 'failed';
	error?: string;
	line?: number;
}

interface TestSuiteGroup {
	suiteName: string;
	tests: TestRowData[];
}

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
	const executedTests = new Map<string, { status: 'passed' | 'failed'; error?: string }>();
	if (fileResult) {
		for (const suite of fileResult.results.suites) {
			for (const test of suite.tests) {
				executedTests.set(`${suite.name}/${test.name}`, { status: test.status, error: test.error });
			}
		}
	}

	if (discoveredTests && discoveredTests.length > 0) {
		return discoveredTests.map((test) => {
			const key = `${test.suiteName}/${test.name}`;
			const fullLabel = test.suiteName === '(top-level)' ? test.name : `${test.suiteName} > ${test.name}`;
			const executed = executedTests.get(key);
			return { key, name: test.name, fullLabel, status: executed?.status, error: executed?.error, line: test.line };
		});
	}

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

function StatusIcon({ status }: { status: TestFileStatus }) {
	switch (status) {
		case 'idle': {
			return <Circle className="size-3.5 shrink-0 text-text-secondary" />;
		}
		case 'running': {
			return <Spinner className="size-3.5 shrink-0 text-text-secondary" />;
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

interface PlayButtonProperties {
	isRunning: boolean;
	onClick: (event: React.MouseEvent) => void;
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
			<div
				className="
					group/row flex min-w-0 cursor-pointer items-center gap-1.5 py-1 pr-2
					text-xs transition-colors select-none
					hover:bg-bg-tertiary
				"
				style={{ paddingLeft: paddingForDepth(1) }}
				onClick={() => setSuiteExpanded(!suiteExpanded)}
			>
				<span
					className="
						flex size-4 shrink-0 items-center justify-center text-text-secondary
					"
				>
					{suiteExpanded ? <ChevronDown className="size-3" /> : <ChevronRight className="size-3" />}
				</span>

				{suiteStatus === 'passed' && <CheckCircle2 className="size-3.5 shrink-0 text-green-600 dark:text-green-400" />}
				{suiteStatus === 'failed' && <XCircle className="size-3.5 shrink-0 text-red-600 dark:text-red-400" />}
				{suiteStatus === 'idle' && <Circle className="size-3.5 shrink-0 text-text-secondary" />}

				<span className="min-w-0 flex-1 truncate font-medium text-text-primary" title={group.suiteName}>
					{group.suiteName}
				</span>

				{onRunFile && <PlayButton isRunning={isRunning} onClick={() => onRunFile(filePath)} />}
			</div>

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
			<span className="size-4 shrink-0" />

			<TestStatusIcon status={row.status} />

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

			{onRunTest && <PlayButton isRunning={isRunning} onClick={() => onRunTest(filePath, row.fullLabel)} />}
		</div>
	);
}

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

				<StatusIcon status={status} />

				<File className="size-3.5 shrink-0 text-text-secondary" />

				<span className="min-w-0 flex-1 truncate text-text-primary" title={filePath}>
					{filePath}
				</span>

				{fileResult && (
					<span className={cn('shrink-0 text-xs text-text-secondary tabular-nums', status === 'running' && 'invisible')}>
						{fileResult.results.passed}/
						{discoveredTests ? Math.max(discoveredTests.length, fileResult.results.total) : fileResult.results.total}
					</span>
				)}

				{onRunFile && <PlayButton isRunning={isRunning} onClick={() => onRunFile(filePath)} />}
			</div>

			{expanded && canExpand && (
				<>
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
