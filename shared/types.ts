import { getPreviewUpdateTargets, isPreviewHotUpdatePath } from './preview-path';

import type { AIModelId } from './constants';
import type { PreviewUpdateTarget } from './preview-path';

export interface FileInfo {
	path: string;
	name: string;
	isDirectory: boolean;
}
export interface FileTreeNode {
	path: string;
	name: string;
	isDirectory: boolean;
	children?: FileTreeNode[];
	level: number;
}
export interface OpenFile {
	path: string;
	content: string;
	isDirty: boolean;
	cursor?: CursorPosition;
}
export interface CursorPosition {
	line: number;
	ch: number;
}
export interface SelectionRange {
	anchor: CursorPosition;
	head: CursorPosition;
}

/**
 * Agent operating mode.
 * - code: Full tool access — reads, writes, edits, deletes files (default).
 * - plan: Read-only research + produces an implementation plan.
 * - ask: Read-only tools — conversational Q&A grounded in the codebase.
 */
export type AgentMode = 'code' | 'plan' | 'ask';

/**
 * Structured tool error info received via stream `tool_error` events.
 * Replaces regex-based `[CODE] message` prefix parsing on the frontend.
 */
export interface ToolErrorInfo {
	toolCallId: string;
	toolName: string;
	errorCode: string;
	errorMessage: string;
}

/**
 * Structured tool result info received via stream `tool_result` events.
 *
 * Each successful tool call emits this alongside its text output. The frontend
 * uses `title` for the collapsed label and `metadata` for rich rendering
 * (e.g. line stats, diagnostics, todo lists) instead of re-parsing raw strings.
 *
 * `metadata` is tool-specific — the UI inspects known fields per tool name.
 */
export interface ToolMetadataInfo {
	toolCallId: string;
	toolName: string;
	title: string;
	metadata: Record<string, unknown>;
}
export interface AiSession {
	id: string;
	title: string;
	titleGenerated?: boolean;
	createdAt: number;
	history: ChatMessage[];
	contextTokensUsed?: number;
	/** Set by the client after a revert to prevent the server-side stream
	 *  `finally` block from overwriting the truncated history. */
	revertedAt?: number;
	/** Structured tool result metadata keyed by toolCallId, persisted so loaded sessions
	 *  render the same rich UI (edit stats, line counts, etc.) as live-streamed ones. */
	toolMetadata?: Record<string, ToolMetadataInfo>;
	toolErrors?: Record<string, ToolErrorInfo>;
	/** Terminal status of the last agent run. Set by the agent-runner after
	 *  the loop finishes so reloaded sessions can restore the AgentError UI. */
	status?: AgentSessionStatus;
	errorMessage?: string;
	stopRequested?: boolean;
}
export interface AiSessionSummary {
	id: string;
	title: string;
	createdAt: number;
}
export type AgentSessionStatus = 'running' | 'completed' | 'error' | 'aborted';
export interface TodoItem {
	id: string;
	content: string;
	status: 'pending' | 'in_progress' | 'completed';
	priority: 'high' | 'medium' | 'low';
}
export type ReviewHunkStatus = 'pending' | 'approved' | 'rejected';
export type ReviewResolutionDecision = 'accept' | 'reject' | 'mixed';

export interface ChangeSetFile {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	sessionId: string;
}

export interface ChangeSet {
	id: string;
	sessionId: string;
	snapshotId: string | undefined;
	createdAt: number;
	files: ChangeSetFile[];
}

export interface ReviewEntry {
	id: string;
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending';
	hunkStatuses: ReviewHunkStatus[];
	hunkSessionIds?: string[][];
	latestSessionId: string;
	sessionIds: string[];
	diffSignature: string;
	updatedAt: number;
}

export interface ReviewSummary {
	unresolvedCount: number;
	reviewVersion: number;
	sessionCounts: Record<string, number>;
}

/**
 * A file change made by the AI that is pending user review.
 * The AI writes files immediately (for HMR preview), but the user
 * can approve (keep) or reject (revert) each change.
 */
export interface PendingFileChange {
	path: string;
	action: 'create' | 'edit' | 'delete' | 'move';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	snapshotId: string | undefined;
	status: 'pending' | 'approved' | 'rejected';
	/**
	 * Per-change-group statuses for hunk-level accept/reject.
	 * Indices correspond to change groups computed by `groupHunksIntoChanges()`.
	 * Starts as `[]` and is populated when the diff is first displayed.
	 */
	hunkStatuses: ReviewHunkStatus[];
	hunkSessionIds?: string[][];
	sessionId: string;
	sessionIds?: string[];
	reviewId?: string;
}
export interface FileChange {
	path: string;
	action: 'create' | 'edit' | 'delete';
	beforeContent: string | undefined;
	afterContent: string | undefined;
	isBinary: boolean;
}
export interface SnapshotMetadata {
	id: string;
	timestamp: number;
	label: string;
	sessionId?: string;
	changes: Array<{
		path: string;
		action: 'create' | 'edit' | 'delete';
	}>;
}
export interface SnapshotSummary {
	id: string;
	timestamp: number;
	label: string;
	changeCount: number;
}
export interface Participant {
	id: string;
	color: string;
	file?: string;
	cursor?: CursorPosition;
	selection?: SelectionRange;
}
export interface HmrUpdate {
	type: 'update' | 'full-reload';
	path: string;
	timestamp: number;
	targets: PreviewUpdateTarget[];
}

/**
 * Create an HmrUpdate for a file content change (write, edit, lint-fix).
 *
 * Determines whether the change can be applied as a hot update or requires
 * a full page reload based on the file extension:
 * - CSS files → hot updates for linked stylesheets and imported css modules
 * - JS/TS/JSX/TSX/JSON/imported assets → graph-driven module hot updates
 * - Other files (HTML, config, unknown assets) → full page reload
 */
export function createHmrUpdateForFile(path: string): HmrUpdate {
	const normalizedPath = path.startsWith('/') ? path : `/${path}`;
	const targets = getPreviewUpdateTargets(normalizedPath);
	const isHmrCapable = isPreviewHotUpdatePath(normalizedPath) && targets.length > 0;

	return {
		type: isHmrCapable ? 'update' : 'full-reload',
		path: normalizedPath,
		timestamp: Date.now(),
		targets,
	};
}
export interface DependencyError {
	packageName: string;
	code: 'unregistered' | 'not-found' | 'resolve-failed';
	message: string;
}
export interface ServerError {
	id: string;
	timestamp: number;
	type: 'bundle' | 'runtime';
	message: string;
	file?: string;
	line?: number;
	column?: number;
	dependencyErrors?: DependencyError[];
}
export interface ServerLogEntry {
	type: 'server-log';
	timestamp: number;
	level: 'log' | 'warning' | 'error' | 'debug' | 'info';
	message: string;
}

/**
 * Metadata for a project template (without file contents).
 * Used by both the GET /api/templates endpoint and the dashboard page.
 */
export interface ProjectTemplateMeta {
	id: string;
	name: string;
	description: string;
	icon: string;
}
export interface FilesResponse {
	files: FileInfo[];
}
export interface FileResponse {
	path: string;
	content: string;
}
export interface ExpirationResponse {
	expiresAt?: number;
	expiresIn?: number;
}
export interface NewProjectResponse {
	projectId: string;
	url: string;
	name: string;
}

/**
 * Cloudflare Workers asset routing configuration.
 * @see https://developers.cloudflare.com/workers/static-assets/
 */
export type NotFoundHandling = 'none' | 'single-page-application' | '404-page';
export type HtmlHandling = 'auto-trailing-slash' | 'force-trailing-slash' | 'drop-trailing-slash' | 'none';

export interface AssetSettings {
	not_found_handling?: NotFoundHandling;
	html_handling?: HtmlHandling;
	run_worker_first?: boolean | string[];
}

export interface ResolvedAssetSettings {
	not_found_handling: NotFoundHandling;
	html_handling: HtmlHandling;
	run_worker_first: boolean | string[];
}

export function resolveAssetSettings(settings?: AssetSettings): ResolvedAssetSettings {
	return {
		not_found_handling: settings?.not_found_handling ?? 'none',
		html_handling: settings?.html_handling ?? 'auto-trailing-slash',
		run_worker_first: settings?.run_worker_first ?? false,
	};
}

/**
 * Bindings configuration stored in wrangler.jsonc.
 * Controls which bindings are injected into the user's worker env.
 */
export interface BindingsConfig {
	storage?: boolean;
}
export interface DiscoveredTest {
	name: string;
	suiteName: string;
	line?: number;
}
export interface DiscoveredTestFile {
	file: string;
	tests: DiscoveredTest[];
}
export interface TestResultEntry {
	name: string;
	status: 'passed' | 'failed';
	error?: string;
	duration: number;
}
export interface TestSuiteResult {
	name: string;
	tests: TestResultEntry[];
	passed: number;
	failed: number;
}
export interface TestFileResult {
	file: string;
	results: {
		suites: TestSuiteResult[];
		passed: number;
		failed: number;
		total: number;
		duration: number;
		error?: string;
	};
}
export interface TestRunResponse {
	title: string;
	output: string;
	metadata: {
		passed: number;
		failed: number;
		total: number;
		files: number;
		bundleErrors: number;
	};
	fileResults: TestFileResult[];
	bundleErrors: Array<{ file: string; error: string }>;
	timestamp: number;
}

/**
 * Merge a single-test run result into an existing full result set.
 * Updates only the specific test(s) that were re-run, keeping all other tests intact.
 * Used client-side when a single test is re-run (from the mutation onSuccess handler
 * and the WebSocket broadcast handler).
 */
export function mergeTestRunResults(existing: TestRunResponse, incoming: TestRunResponse): TestRunResponse {
	const updatedFileResults: TestFileResult[] = existing.fileResults.map((existingFile) => {
		const incomingFile = incoming.fileResults.find((f) => f.file === existingFile.file);
		if (!incomingFile) return existingFile;

		// Group all tests (existing and incoming) by suite so we don't lose any
		const mergedSuitesMap = new Map<string, Map<string, TestSuiteResult['tests'][number]>>();

		// 1. Add all existing tests into the map
		for (const suite of existingFile.results.suites) {
			const suiteMap = new Map<string, TestSuiteResult['tests'][number]>();
			for (const test of suite.tests) {
				suiteMap.set(test.name, test);
			}
			mergedSuitesMap.set(suite.name, suiteMap);
		}

		// 2. Overlay incoming tests (adding new ones, replacing existing ones)
		for (const suite of incomingFile.results.suites) {
			let suiteMap = mergedSuitesMap.get(suite.name);
			if (!suiteMap) {
				suiteMap = new Map<string, TestSuiteResult['tests'][number]>();
				mergedSuitesMap.set(suite.name, suiteMap);
			}
			for (const test of suite.tests) {
				suiteMap.set(test.name, test);
			}
		}

		// 3. Rebuild the suites array and aggregate counts
		const mergedSuites: TestSuiteResult[] = [];
		let totalPassed = 0;
		let totalFailed = 0;
		let totalCount = 0;

		for (const [suiteName, testsMap] of mergedSuitesMap.entries()) {
			let suitePassed = 0;
			let suiteFailed = 0;
			const mergedTests = [...testsMap.values()];

			for (const test of mergedTests) {
				if (test.status === 'passed') {
					suitePassed++;
				} else {
					suiteFailed++;
				}
			}

			mergedSuites.push({
				name: suiteName,
				tests: mergedTests,
				passed: suitePassed,
				failed: suiteFailed,
			});

			totalPassed += suitePassed;
			totalFailed += suiteFailed;
			totalCount += mergedTests.length;
		}

		return {
			file: existingFile.file,
			results: {
				...existingFile.results,
				suites: mergedSuites,
				passed: totalPassed,
				failed: totalFailed,
				total: totalCount,
			},
		};
	});

	// Recompute top-level metadata
	let passed = 0;
	let failed = 0;
	let total = 0;
	for (const fileResult of updatedFileResults) {
		passed += fileResult.results.passed;
		failed += fileResult.results.failed;
		total += fileResult.results.total;
	}

	return {
		...existing,
		fileResults: updatedFileResults,
		metadata: {
			...existing.metadata,
			passed,
			failed,
			total,
		},
		title: failed === 0 ? `${passed} passed` : `${failed} failed, ${passed} passed`,
		timestamp: incoming.timestamp,
	};
}

/**
 * Possible status values for a file in the git working tree.
 *
 * The values map to isomorphic-git statusMatrix [HEAD, WORKDIR, STAGE]:
 * - untracked:                [0, 2, 0] — new file not yet staged
 * - untracked-staged:         [0, 2, 2] — new file, fully staged
 * - untracked-partially-staged: [0, 2, 3] — new file, staged version differs from working
 * - unmodified:               [1, 1, 1] — clean, committed
 * - modified:                 [1, 2, 1] — modified in workdir, not staged
 * - modified-staged:          [1, 2, 2] — modified, fully staged
 * - modified-partially-staged: [1, 2, 3] — modified, staged version differs from working
 * - deleted:                  [1, 0, 1] — deleted in workdir, not staged
 * - deleted-staged:           [1, 0, 0] — deleted, staged for removal
 * - added:                    [0, 2, 2] — alias for untracked-staged in simplified views
 */
export type GitFileStatus =
	| 'untracked'
	| 'untracked-staged'
	| 'untracked-partially-staged'
	| 'unmodified'
	| 'modified'
	| 'modified-staged'
	| 'modified-partially-staged'
	| 'deleted'
	| 'deleted-staged';
export interface GitStatusEntry {
	path: string;
	status: GitFileStatus;
	staged: boolean;
	headStatus: number;
	workdirStatus: number;
	stageStatus: number;
}
export interface GitBranchInfo {
	name: string;
	isCurrent: boolean;
}
export interface GitAuthor {
	name: string;
	email: string;
	timestamp: number;
}
export interface GitCommitEntry {
	objectId: string;
	abbreviatedObjectId: string;
	message: string;
	author: GitAuthor;
	parentObjectIds: string[];
}
export interface GitGraphConnection {
	fromColumn: number;
	toColumn: number;
	color: string;
}
export interface GitGraphEntry extends GitCommitEntry {
	column: number;
	connections: GitGraphConnection[];
	branchNames: string[];
	tagNames: string[];
}
export interface GitDiffLine {
	type: 'add' | 'remove' | 'context';
	content: string;
}
export interface GitDiffHunk {
	oldStart: number;
	oldLines: number;
	newStart: number;
	newLines: number;
	lines: GitDiffLine[];
}
export interface GitFileDiff {
	path: string;
	status: 'modified' | 'added' | 'deleted';
	hunks: GitDiffHunk[];
	beforeContent?: string;
	afterContent?: string;
}
export interface GitStashEntry {
	index: number;
	message: string;
	objectId: string;
}
export interface GitMergeResult {
	objectId?: string;
	alreadyMerged?: boolean;
	fastForward?: boolean;
	conflicts?: string[];
}

/**
 * A single part of a chat message.
 *
 * Messages are composed of parts to support mixed content: text interspersed
 * with tool calls, tool results, and model reasoning/thinking blocks.
 */
export interface TextPart {
	type: 'text';
	content: string;
}
export interface PreviewElementAttributes {
	id?: string;
	name?: string;
	alt?: string;
	title?: string;
	placeholder?: string;
	type?: string;
	href?: string;
	src?: string;
}
export interface PreviewElementReference {
	tagName: string;
	primarySelector: string;
	locatorCandidates: string[];
	containerSelector?: string;
	textPreview?: string;
	accessibleName?: string;
	role?: string;
	className?: string;
	attributes?: PreviewElementAttributes;
}
export interface PreviewElementPart extends PreviewElementReference {
	type: 'preview-element';
}
export interface ToolCallPart {
	type: 'tool-call';
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}
export interface ToolResultPart {
	type: 'tool-result';
	toolCallId: string;
	toolName: string;
	result: string;
	isError?: boolean;
}
export interface ReasoningPart {
	type: 'reasoning';
	content: string;
}
export type UserMessagePart = TextPart | PreviewElementPart;
export type MessagePart = TextPart | PreviewElementPart | ToolCallPart | ToolResultPart | ReasoningPart;

/**
 * A single message in the AI chat conversation.
 *
 * App-owned message type that gives full control over the message format
 * without external dependency coupling.
 */
export interface ChatMessage {
	id: string;
	role: 'user' | 'assistant';
	parts: MessagePart[];
	authorUserId?: string;
	createdAt?: number;
	metadata?: {
		request?: {
			mode?: AgentMode;
			model?: AIModelId;
			state: 'queued' | 'committed';
		};
		snapshotId?: string;
	};
}
