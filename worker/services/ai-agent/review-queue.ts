import fs from 'node:fs/promises';

import { eq } from 'drizzle-orm';

import { computeDiffHunks, groupHunksIntoChanges, reconstructContent } from '@shared/review-diff';
import {
	createHmrUpdateForFile,
	type ChangeSetFile,
	type PendingFileChange,
	type ReviewEntry as SharedReviewEntry,
	type ReviewHunkStatus,
	type ReviewHunkStatus as SharedReviewHunkStatus,
	type ReviewResolutionDecision,
	type ReviewSummary,
} from '@shared/types';

import { accumulatePendingChange } from './pending-changes';
import { deletePendingChanges, writePendingChangesData } from '../../durable/db';
import {
	changeSetFiles,
	changeSets,
	reviewEntries,
	reviewEntrySources,
	reviewResolutions,
	sessionPendingChangeIndex,
	sessionPendingChanges,
} from '../../durable/db/schema';
import { coordinatorNamespace } from '../../lib/durable-object-namespaces';

import type { AgentDatabase } from '../../durable/db';

interface PendingChangeContribution {
	change: PendingFileChange;
	sessionId: string;
	updatedAt: number;
	latestChangeSetId: string | undefined;
}

type ReviewEntryRow = typeof reviewEntries.$inferSelect;
type SessionPendingChangeIndexRow = typeof sessionPendingChangeIndex.$inferSelect;
type SessionPendingChangesRow = typeof sessionPendingChanges.$inferSelect;

function parsePendingChangesRecord(raw: string): Record<string, PendingFileChange> {
	try {
		const parsed: unknown = JSON.parse(raw);
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return {};
		}
		const record: Record<string, PendingFileChange> = {};
		for (const [key, value] of Object.entries(parsed)) {
			if (!value || typeof value !== 'object' || Array.isArray(value)) {
				continue;
			}
			const pendingChange = value;
			if (
				typeof pendingChange.path !== 'string' ||
				typeof pendingChange.action !== 'string' ||
				typeof pendingChange.sessionId !== 'string'
			) {
				continue;
			}
			const rawHunkStatuses: unknown[] = Array.isArray(pendingChange.hunkStatuses) ? pendingChange.hunkStatuses : [];
			const rawSessionIds: unknown[] = Array.isArray(pendingChange.sessionIds) ? pendingChange.sessionIds : [];
			record[key] = {
				path: pendingChange.path,
				action:
					pendingChange.action === 'create' ||
					pendingChange.action === 'edit' ||
					pendingChange.action === 'delete' ||
					pendingChange.action === 'move'
						? pendingChange.action
						: 'edit',
				beforeContent: typeof pendingChange.beforeContent === 'string' ? pendingChange.beforeContent : undefined,
				afterContent: typeof pendingChange.afterContent === 'string' ? pendingChange.afterContent : undefined,
				snapshotId: typeof pendingChange.snapshotId === 'string' ? pendingChange.snapshotId : undefined,
				status: pendingChange.status === 'approved' || pendingChange.status === 'rejected' ? pendingChange.status : 'pending',
				hunkStatuses: rawHunkStatuses.filter(
					(status): status is ReviewHunkStatus => status === 'pending' || status === 'approved' || status === 'rejected',
				),
				sessionId: pendingChange.sessionId,
				sessionIds: rawSessionIds.filter((sessionId): sessionId is string => typeof sessionId === 'string'),
				reviewId: typeof pendingChange.reviewId === 'string' ? pendingChange.reviewId : undefined,
			};
		}
		return record;
	} catch {
		return {};
	}
}

function parseStringArray(raw: string): string[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === 'string') : [];
	} catch {
		return [];
	}
}

function parseHunkStatuses(raw: string): ReviewHunkStatus[] {
	try {
		const parsed: unknown = JSON.parse(raw);
		return Array.isArray(parsed)
			? parsed.filter((status): status is ReviewHunkStatus => status === 'pending' || status === 'approved' || status === 'rejected')
			: [];
	} catch {
		return [];
	}
}

function stringify(value: unknown): string {
	return JSON.stringify(value);
}

function hashString(input = ''): string {
	let hash = 2_166_136_261;
	for (const character of input) {
		hash ^= character.codePointAt(0) ?? 0;
		hash += (hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24);
	}
	return (hash >>> 0).toString(16);
}

function buildDiffSignature(change: Pick<PendingFileChange, 'action' | 'beforeContent' | 'afterContent'>): string {
	return `${change.action}:${hashString(change.beforeContent)}:${hashString(change.afterContent)}`;
}

function buildInitialHunkStatuses(change: Pick<PendingFileChange, 'action' | 'beforeContent' | 'afterContent'>): ReviewHunkStatus[] {
	if (change.action === 'move') {
		return [];
	}
	const beforeContent = change.beforeContent ?? '';
	const afterContent = change.afterContent ?? '';
	const groups = groupHunksIntoChanges(computeDiffHunks(beforeContent, afterContent));
	return groups.map(() => 'pending');
}

function areSamePendingChange(left: PendingFileChange | undefined, right: PendingFileChange | undefined): boolean {
	if (!left || !right) {
		return left === right;
	}
	return (
		left.path === right.path &&
		left.action === right.action &&
		left.beforeContent === right.beforeContent &&
		left.afterContent === right.afterContent &&
		left.snapshotId === right.snapshotId
	);
}

function parsePendingAction(value: string): SharedReviewEntry['action'] {
	if (value === 'create' || value === 'edit' || value === 'delete' || value === 'move') {
		return value;
	}
	return 'edit';
}

function toReviewEntry(row: typeof reviewEntries.$inferSelect): SharedReviewEntry {
	return {
		id: row.id,
		path: row.path,
		action: parsePendingAction(row.action),
		beforeContent: row.beforeContent ?? undefined,
		afterContent: row.afterContent ?? undefined,
		snapshotId: row.snapshotId ?? undefined,
		status: 'pending',
		hunkStatuses: parseHunkStatuses(row.hunkStatuses),
		latestSessionId: row.latestSessionId,
		sessionIds: parseStringArray(row.sessionIds),
		diffSignature: row.diffSignature,
		updatedAt: row.updatedAt,
	};
}

function buildReviewSummary(entries: SharedReviewEntry[], reviewVersion: number): ReviewSummary {
	const sessionCounts: Record<string, number> = {};
	for (const entry of entries) {
		for (const sessionId of entry.sessionIds) {
			sessionCounts[sessionId] = (sessionCounts[sessionId] ?? 0) + 1;
		}
	}
	return {
		unresolvedCount: entries.length,
		reviewVersion,
		sessionCounts,
	};
}

async function readWorkspaceContent(projectRoot: string, path: string): Promise<string | undefined> {
	try {
		return await fs.readFile(`${projectRoot}${path}`, 'utf8');
	} catch {
		return undefined;
	}
}

async function writeWorkspaceContent(projectRoot: string, path: string, content: string): Promise<void> {
	const directory = path.slice(0, path.lastIndexOf('/'));
	if (directory) {
		await fs.mkdir(`${projectRoot}${directory}`, { recursive: true });
	}
	await fs.writeFile(`${projectRoot}${path}`, content);
}

async function deleteWorkspacePath(projectRoot: string, path: string): Promise<void> {
	await fs.rm(`${projectRoot}${path}`, { recursive: true, force: true });
}

async function notifyWorkspaceChange(projectId: string, path: string, forceFullReload = false): Promise<void> {
	const coordinatorStub = coordinatorNamespace.getByName(`project:${projectId}`);
	await coordinatorStub.triggerUpdate(
		forceFullReload
			? {
					type: 'full-reload',
					path,
					timestamp: Date.now(),
					targets: [],
				}
			: createHmrUpdateForFile(path),
	);
	await coordinatorStub.sendMessage({ type: 'git-status-changed' });
}

export class ReviewQueueStore {
	private readonly db: AgentDatabase;

	constructor(database: AgentDatabase) {
		this.db = database;
	}

	listReviewEntries(): SharedReviewEntry[] {
		const rows: ReviewEntryRow[] = this.db.select().from(reviewEntries).all();
		return rows.map((row) => toReviewEntry(row)).toSorted((left, right) => right.updatedAt - left.updatedAt);
	}

	listReviewEntriesRecord(): Record<string, SharedReviewEntry> {
		return Object.fromEntries(this.listReviewEntries().map((entry) => [entry.path, entry]));
	}

	getReviewSummary(reviewVersion: number): ReviewSummary {
		return buildReviewSummary(this.listReviewEntries(), reviewVersion);
	}

	readSessionPendingChanges(sessionId: string): Record<string, PendingFileChange> {
		const rows: SessionPendingChangesRow[] = this.db
			.select()
			.from(sessionPendingChanges)
			.where(eq(sessionPendingChanges.sessionId, sessionId))
			.all();
		const row = rows[0];
		return row ? parsePendingChangesRecord(row.data) : {};
	}

	countSessionPendingChangeRows(): number {
		return this.db.select().from(sessionPendingChanges).all().length;
	}

	bootstrapLegacyPendingChanges(legacyChanges: Record<string, PendingFileChange>): void {
		if (this.countSessionPendingChangeRows() > 0 || Object.keys(legacyChanges).length === 0) {
			return;
		}

		const changesBySession = new Map<string, Record<string, PendingFileChange>>();
		const now = Date.now();
		for (const change of Object.values(legacyChanges)) {
			const sessionId = change.sessionId || 'legacy';
			const sessionChanges = changesBySession.get(sessionId) ?? {};
			sessionChanges[change.path] = { ...change };
			changesBySession.set(sessionId, sessionChanges);
		}

		for (const [sessionId, sessionChanges] of changesBySession) {
			this.writeSessionPendingChangesRow(sessionId, sessionChanges);
			for (const path of Object.keys(sessionChanges)) {
				this.db.insert(sessionPendingChangeIndex).values({ sessionId, path, updatedAt: now, latestChangeSetId: undefined }).run();
			}
		}

		this.rebuildReviewQueue();
	}

	syncSessionPendingChanges(sessionId: string, nextChanges: Record<string, PendingFileChange>): void {
		const previousChanges = this.readSessionPendingChanges(sessionId);
		const previousIndexRows: SessionPendingChangeIndexRow[] = this.db
			.select()
			.from(sessionPendingChangeIndex)
			.where(eq(sessionPendingChangeIndex.sessionId, sessionId))
			.all();
		const previousIndexByPath = new Map<string, SessionPendingChangeIndexRow>();
		for (const row of previousIndexRows) {
			previousIndexByPath.set(row.path, row);
		}

		const deltaFiles: ChangeSetFile[] = [];
		for (const [path, nextChange] of Object.entries(nextChanges)) {
			if (areSamePendingChange(previousChanges[path], nextChange)) {
				continue;
			}
			deltaFiles.push({
				path,
				action: nextChange.action,
				beforeContent: nextChange.beforeContent,
				afterContent: nextChange.afterContent,
				snapshotId: nextChange.snapshotId,
				sessionId,
			});
		}

		const now = Date.now();
		let latestChangeSetId: string | undefined;
		if (deltaFiles.length > 0) {
			const createdChangeSetId = crypto.randomUUID();
			latestChangeSetId = createdChangeSetId;
			this.db
				.insert(changeSets)
				.values({
					id: createdChangeSetId,
					sessionId,
					snapshotId: deltaFiles.at(-1)?.snapshotId,
					createdAt: now,
				})
				.run();
			this.db
				.insert(changeSetFiles)
				.values(
					deltaFiles.map((file) => ({
						changeSetId: createdChangeSetId,
						sessionId: file.sessionId,
						path: file.path,
						action: file.action,
						beforeContent: file.beforeContent,
						afterContent: file.afterContent,
						snapshotId: file.snapshotId,
					})),
				)
				.run();
		}

		this.writeSessionPendingChangesRow(sessionId, nextChanges);
		this.db.delete(sessionPendingChangeIndex).where(eq(sessionPendingChangeIndex.sessionId, sessionId)).run();

		for (const [path, nextChange] of Object.entries(nextChanges)) {
			const previousIndex = previousIndexByPath.get(path);
			const changed = !areSamePendingChange(previousChanges[path], nextChange);
			this.db
				.insert(sessionPendingChangeIndex)
				.values({
					sessionId,
					path,
					updatedAt: changed ? now : (previousIndex?.updatedAt ?? now),
					latestChangeSetId: changed ? latestChangeSetId : (previousIndex?.latestChangeSetId ?? undefined),
				})
				.run();
		}

		this.rebuildReviewQueue();
	}

	removeSession(sessionId: string): void {
		this.db.delete(sessionPendingChanges).where(eq(sessionPendingChanges.sessionId, sessionId)).run();
		this.db.delete(sessionPendingChangeIndex).where(eq(sessionPendingChangeIndex.sessionId, sessionId)).run();
		this.rebuildReviewQueue();
	}

	moveTrackedPath(fromPath: string, toPath: string): void {
		const rows: SessionPendingChangesRow[] = this.db.select().from(sessionPendingChanges).all();
		let changed = false;
		for (const row of rows) {
			const changes = parsePendingChangesRecord(row.data);
			const previousIndexRows: SessionPendingChangeIndexRow[] = this.db
				.select()
				.from(sessionPendingChangeIndex)
				.where(eq(sessionPendingChangeIndex.sessionId, row.sessionId))
				.all();
			const previousIndexByPath = new Map<string, SessionPendingChangeIndexRow>();
			for (const indexRow of previousIndexRows) {
				previousIndexByPath.set(indexRow.path, indexRow);
			}
			const trackedChange = changes[fromPath];
			if (!trackedChange) {
				continue;
			}
			delete changes[fromPath];
			const movedChange: PendingFileChange = { ...trackedChange, path: toPath };
			const existingDestination = changes[toPath];
			if (existingDestination) {
				const merged = new Map<string, PendingFileChange>([[toPath, existingDestination]]);
				accumulatePendingChange(merged, movedChange);
				const mergedChange = merged.get(toPath);
				if (mergedChange) {
					changes[toPath] = mergedChange;
				}
			} else {
				changes[toPath] = movedChange;
			}
			this.writeSessionPendingChangesRow(row.sessionId, changes);
			this.db.delete(sessionPendingChangeIndex).where(eq(sessionPendingChangeIndex.sessionId, row.sessionId)).run();
			for (const path of Object.keys(changes)) {
				const existingIndex = path === toPath ? previousIndexByPath.get(fromPath) : previousIndexByPath.get(path);
				this.db
					.insert(sessionPendingChangeIndex)
					.values({
						sessionId: row.sessionId,
						path,
						updatedAt: existingIndex?.updatedAt ?? Date.now(),
						latestChangeSetId: existingIndex?.latestChangeSetId ?? undefined,
					})
					.run();
			}
			changed = true;
		}

		if (changed) {
			this.rebuildReviewQueue();
		}
	}

	syncTrackedPathFromWorkspace(projectRoot: string, path: string): Promise<void> {
		return this.syncTrackedPathsFromWorkspace(projectRoot, [path]);
	}

	async syncTrackedPathsFromWorkspace(projectRoot: string, paths: string[]): Promise<void> {
		const rows: SessionPendingChangesRow[] = this.db.select().from(sessionPendingChanges).all();
		const trackedPaths = new Set(paths);
		let changed = false;
		for (const row of rows) {
			const changes = parsePendingChangesRecord(row.data);
			const previousIndexRows: SessionPendingChangeIndexRow[] = this.db
				.select()
				.from(sessionPendingChangeIndex)
				.where(eq(sessionPendingChangeIndex.sessionId, row.sessionId))
				.all();
			const previousIndexByPath = new Map<string, SessionPendingChangeIndexRow>();
			for (const indexRow of previousIndexRows) {
				previousIndexByPath.set(indexRow.path, indexRow);
			}
			let rowChanged = false;
			for (const path of trackedPaths) {
				const trackedChange = changes[path];
				if (!trackedChange || trackedChange.action === 'move') {
					continue;
				}
				const currentContent = await readWorkspaceContent(projectRoot, path);
				const nextTrackedChange = derivePendingChangeFromWorkspace(trackedChange, currentContent);
				if (!nextTrackedChange) {
					delete changes[path];
					rowChanged = true;
					continue;
				}
				if (!areSamePendingChange(trackedChange, nextTrackedChange)) {
					changes[path] = nextTrackedChange;
					rowChanged = true;
				}
			}
			if (rowChanged) {
				this.writeSessionPendingChangesRow(row.sessionId, changes);
				this.db.delete(sessionPendingChangeIndex).where(eq(sessionPendingChangeIndex.sessionId, row.sessionId)).run();
				for (const pendingChange of Object.values(changes)) {
					const previousIndex = previousIndexByPath.get(pendingChange.path);
					this.db
						.insert(sessionPendingChangeIndex)
						.values({
							sessionId: row.sessionId,
							path: pendingChange.path,
							updatedAt: previousIndex?.updatedAt ?? Date.now(),
							latestChangeSetId: previousIndex?.latestChangeSetId ?? undefined,
						})
						.run();
				}
				changed = true;
			}
		}

		if (changed) {
			this.rebuildReviewQueue();
		}
	}

	async updateHunkStatuses(
		projectRoot: string,
		projectId: string,
		reviewEntryId: string,
		hunkStatuses: SharedReviewHunkStatus[],
	): Promise<void> {
		const entry = this.db.select().from(reviewEntries).where(eq(reviewEntries.id, reviewEntryId)).all()[0];
		if (!entry) {
			return;
		}
		const reviewEntry = toReviewEntry(entry);
		this.db
			.update(reviewEntries)
			.set({ hunkStatuses: stringify(hunkStatuses) })
			.where(eq(reviewEntries.id, reviewEntryId))
			.run();
		await this.applyReviewEntryWorkspaceState(projectRoot, projectId, reviewEntry, hunkStatuses, false);
		if (hunkStatuses.every((status) => status !== 'pending')) {
			await this.finalizeResolvedEntry(projectRoot, projectId, reviewEntry, resolveDecisionFromHunks(hunkStatuses), hunkStatuses);
			return;
		}
		this.rebuildReviewQueue();
	}

	async resolveEntry(
		projectRoot: string,
		projectId: string,
		reviewEntryId: string,
		decision: Extract<ReviewResolutionDecision, 'accept' | 'reject'>,
	): Promise<void> {
		const entry = this.db.select().from(reviewEntries).where(eq(reviewEntries.id, reviewEntryId)).all()[0];
		if (!entry) {
			return;
		}
		const reviewEntry = toReviewEntry(entry);
		await this.finalizeResolvedEntry(projectRoot, projectId, reviewEntry, decision, reviewEntry.hunkStatuses);
	}

	async resolveEntries(
		projectRoot: string,
		projectId: string,
		decision: Extract<ReviewResolutionDecision, 'accept' | 'reject'>,
		sessionId?: string,
		reviewIds?: string[],
	): Promise<void> {
		const entries = this.listReviewEntries().filter((entry) => {
			if (reviewIds && reviewIds.length > 0) {
				return reviewIds.includes(entry.id);
			}
			if (!sessionId) {
				return true;
			}
			return entry.sessionIds.includes(sessionId);
		});
		for (const entry of entries) {
			await this.finalizeResolvedEntry(projectRoot, projectId, entry, decision, entry.hunkStatuses);
		}
	}

	private writeSessionPendingChangesRow(sessionId: string, changes: Record<string, PendingFileChange>): void {
		if (Object.keys(changes).length === 0) {
			this.db.delete(sessionPendingChanges).where(eq(sessionPendingChanges.sessionId, sessionId)).run();
			this.db.delete(sessionPendingChangeIndex).where(eq(sessionPendingChangeIndex.sessionId, sessionId)).run();
			return;
		}
		this.db
			.insert(sessionPendingChanges)
			.values({ sessionId, data: stringify(changes) })
			.onConflictDoUpdate({
				target: sessionPendingChanges.sessionId,
				set: { data: stringify(changes) },
			})
			.run();
	}

	private rebuildReviewQueue(): void {
		const previousEntriesByPath = new Map<string, SharedReviewEntry>();
		for (const entry of this.listReviewEntries()) {
			previousEntriesByPath.set(entry.path, entry);
		}
		const sessionRows: SessionPendingChangesRow[] = this.db.select().from(sessionPendingChanges).all();
		const indexRows: SessionPendingChangeIndexRow[] = this.db.select().from(sessionPendingChangeIndex).all();
		const indexByKey = new Map<string, SessionPendingChangeIndexRow>();
		for (const row of indexRows) {
			indexByKey.set(`${row.sessionId}:${row.path}`, row);
		}

		const contributionsByPath = new Map<string, PendingChangeContribution[]>();
		for (const row of sessionRows) {
			const changes = parsePendingChangesRecord(row.data);
			for (const change of Object.values(changes)) {
				const indexRow = indexByKey.get(`${row.sessionId}:${change.path}`);
				const contributions = contributionsByPath.get(change.path) ?? [];
				contributions.push({
					change: { ...change, sessionId: row.sessionId },
					sessionId: row.sessionId,
					updatedAt: indexRow?.updatedAt ?? 0,
					latestChangeSetId: indexRow?.latestChangeSetId ?? undefined,
				});
				contributionsByPath.set(change.path, contributions);
			}
		}

		this.db.delete(reviewEntrySources).run();
		this.db.delete(reviewEntries).run();

		const legacyPendingChanges: Record<string, PendingFileChange> = {};

		for (const [path, contributions] of contributionsByPath) {
			const orderedContributions = contributions.toSorted((left, right) => left.updatedAt - right.updatedAt);
			const merged = new Map<string, PendingFileChange>();
			for (const contribution of orderedContributions) {
				accumulatePendingChange(merged, contribution.change);
			}
			const finalChange = merged.get(path);
			if (!finalChange) {
				continue;
			}

			const sessionIds = [...new Set(orderedContributions.map((contribution) => contribution.sessionId))];
			const latestSessionId = sessionIds.at(-1) ?? finalChange.sessionId;
			const diffSignature = buildDiffSignature(finalChange);
			const previousEntry = previousEntriesByPath.get(path);
			const hunkStatuses =
				previousEntry?.diffSignature === diffSignature ? previousEntry.hunkStatuses : buildInitialHunkStatuses(finalChange);
			const reviewEntryId = previousEntry?.id ?? crypto.randomUUID();
			const updatedAt = orderedContributions.at(-1)?.updatedAt ?? Date.now();

			this.db
				.insert(reviewEntries)
				.values({
					id: reviewEntryId,
					path,
					action: finalChange.action,
					beforeContent: finalChange.beforeContent,
					afterContent: finalChange.afterContent,
					snapshotId: finalChange.snapshotId,
					status: 'pending',
					hunkStatuses: stringify(hunkStatuses),
					latestSessionId,
					sessionIds: stringify(sessionIds),
					diffSignature,
					updatedAt,
				})
				.run();

			const sourceChangeSetIds = [...new Set(orderedContributions.map((contribution) => contribution.latestChangeSetId))].filter(
				(changeSetId): changeSetId is string => typeof changeSetId === 'string' && changeSetId.length > 0,
			);
			for (const [orderIndex, changeSetId] of sourceChangeSetIds.entries()) {
				this.db.insert(reviewEntrySources).values({ reviewEntryId, changeSetId, orderIndex }).run();
			}

			legacyPendingChanges[path] = {
				...finalChange,
				status: 'pending',
				hunkStatuses,
				sessionId: latestSessionId,
				sessionIds,
				reviewId: reviewEntryId,
			};
		}

		if (Object.keys(legacyPendingChanges).length === 0) {
			deletePendingChanges(this.db);
			return;
		}

		writePendingChangesData(this.db, stringify(legacyPendingChanges));
	}

	private async applyReviewEntryWorkspaceState(
		projectRoot: string,
		projectId: string,
		reviewEntry: SharedReviewEntry,
		hunkStatuses: SharedReviewHunkStatus[],
		finalizing: boolean,
	): Promise<void> {
		if (reviewEntry.action === 'move') {
			return;
		}
		if (reviewEntry.beforeContent === undefined && reviewEntry.afterContent === undefined) {
			return;
		}

		const beforeContent = reviewEntry.beforeContent ?? '';
		const afterContent = reviewEntry.afterContent ?? '';
		const decisions = hunkStatuses.map((status) => status !== 'rejected');
		const reconstructed = reconstructContent(beforeContent, afterContent, decisions);

		if (reviewEntry.action === 'create' && finalizing && hunkStatuses.every((status) => status === 'rejected')) {
			await deleteWorkspacePath(projectRoot, reviewEntry.path);
			await notifyWorkspaceChange(projectId, reviewEntry.path, true);
			return;
		}

		await writeWorkspaceContent(projectRoot, reviewEntry.path, reconstructed);
		await notifyWorkspaceChange(projectId, reviewEntry.path);
	}

	private async finalizeResolvedEntry(
		projectRoot: string,
		projectId: string,
		reviewEntry: SharedReviewEntry,
		decision: ReviewResolutionDecision,
		existingHunkStatuses: SharedReviewHunkStatus[],
	): Promise<void> {
		let resolutionDecision: ReviewResolutionDecision = decision;
		let finalHunkStatuses = existingHunkStatuses;

		if (decision === 'reject' && existingHunkStatuses.length > 0) {
			finalHunkStatuses = existingHunkStatuses.map((status) => (status === 'pending' ? 'rejected' : status));
			resolutionDecision = resolveDecisionFromHunks(finalHunkStatuses);
		}

		if (decision === 'reject' && resolutionDecision === 'reject') {
			if (reviewEntry.action === 'create') {
				await deleteWorkspacePath(projectRoot, reviewEntry.path);
				await notifyWorkspaceChange(projectId, reviewEntry.path, true);
			} else if (reviewEntry.beforeContent !== undefined) {
				await writeWorkspaceContent(projectRoot, reviewEntry.path, reviewEntry.beforeContent);
				await notifyWorkspaceChange(projectId, reviewEntry.path);
			}
		} else if (finalHunkStatuses.length > 0) {
			await this.applyReviewEntryWorkspaceState(projectRoot, projectId, reviewEntry, finalHunkStatuses, true);
		}

		this.db
			.insert(reviewResolutions)
			.values({
				id: crypto.randomUUID(),
				reviewEntryId: reviewEntry.id,
				decision: resolutionDecision,
				hunkStatuses: stringify(finalHunkStatuses),
				resolvedAt: Date.now(),
			})
			.run();

		const rows: SessionPendingChangesRow[] = this.db.select().from(sessionPendingChanges).all();
		for (const row of rows) {
			const changes = parsePendingChangesRecord(row.data);
			if (!(reviewEntry.path in changes)) {
				continue;
			}
			delete changes[reviewEntry.path];
			this.writeSessionPendingChangesRow(row.sessionId, changes);
		}

		this.rebuildReviewQueue();
	}
}

function derivePendingChangeFromWorkspace(change: PendingFileChange, currentContent: string | undefined): PendingFileChange | undefined {
	if (currentContent === undefined) {
		if (change.beforeContent === undefined) {
			return undefined;
		}
		return {
			...change,
			action: 'delete',
			afterContent: undefined,
		};
	}

	if (change.beforeContent !== undefined && change.beforeContent === currentContent) {
		return undefined;
	}

	return {
		...change,
		action: change.beforeContent === undefined ? 'create' : 'edit',
		afterContent: currentContent,
	};
}

function resolveDecisionFromHunks(hunkStatuses: SharedReviewHunkStatus[]): ReviewResolutionDecision {
	if (hunkStatuses.length === 0) {
		return 'accept';
	}
	if (hunkStatuses.every((status) => status === 'approved')) {
		return 'accept';
	}
	if (hunkStatuses.every((status) => status === 'rejected')) {
		return 'reject';
	}
	return 'mixed';
}
