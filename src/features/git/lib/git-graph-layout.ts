/**
 * Git graph layout engine.
 *
 * Computes column positions and connection lines for rendering
 * a branch graph (SVG) alongside the commit history list.
 *
 * The algorithm tracks "active lanes" — each lane is an expected
 * commit OID. When a commit is rendered, it is placed in the lane
 * that was expecting it (or a new lane is allocated). Parent OIDs
 * are then assigned to lanes for future rows.
 */

import { COLLAB_COLORS } from '@shared/constants';

import type { GitBranchInfo, GitCommitEntry, GitGraphConnection, GitGraphEntry } from '@shared/types';

// =============================================================================
// Layout Constants
// =============================================================================

/** Horizontal spacing between graph columns (px) */
export const COLUMN_WIDTH = 20;
/** Vertical spacing between rows (px) */
export const ROW_HEIGHT = 32;
/** Radius of the commit circle (px) */
export const COMMIT_RADIUS = 4;

// =============================================================================
// Color Assignment
// =============================================================================

const GRAPH_COLORS: readonly string[] = COLLAB_COLORS;

function getColumnColor(column: number): string {
	return GRAPH_COLORS[column % GRAPH_COLORS.length];
}

// =============================================================================
// Layout Algorithm
// =============================================================================

interface Lane {
	/** The OID this lane is expecting */
	expectedObjectId: string;
	/** Color index (column where the lane was born) */
	colorColumn: number;
}

/**
 * Find the index of the first empty (undefined) slot in the lane array.
 * Returns -1 if all slots are occupied.
 */
function findEmptyLane(lanes: ReadonlyArray<Lane | undefined>): number {
	for (const [index, lane] of lanes.entries()) {
		if (lane === undefined) {
			return index;
		}
	}
	return -1;
}

/**
 * Build ref lookup maps: OID -> branch names and OID -> tag names.
 */
function buildReferenceMaps(
	branches: ReadonlyArray<GitBranchInfo>,
	tags: ReadonlyArray<string>,
	commits: ReadonlyArray<GitCommitEntry>,
): { branchMap: Map<string, string[]>; tagMap: Map<string, string[]> } {
	// For branches we need to resolve them to OIDs. Since the API returns
	// branch info without OIDs, we approximate: the current branch points to
	// the first commit (HEAD). Other branches are not resolved here — they
	// would need separate OID data from the API. This is a simplified model.
	const branchMap = new Map<string, string[]>();
	const tagMap = new Map<string, string[]>();

	// If there is a current branch, it points at HEAD (first commit)
	if (commits.length > 0) {
		const headObjectId = commits[0].objectId;
		for (const branch of branches) {
			if (branch.isCurrent) {
				const existing = branchMap.get(headObjectId) ?? [];
				existing.push(branch.name);
				branchMap.set(headObjectId, existing);
			}
		}
	}

	// Tags are passed as "name:oid" strings for simplicity
	for (const tag of tags) {
		const separatorIndex = tag.indexOf(':');
		if (separatorIndex === -1) {
			continue;
		}
		const name = tag.slice(0, separatorIndex);
		const objectId = tag.slice(separatorIndex + 1);
		const existing = tagMap.get(objectId) ?? [];
		existing.push(name);
		tagMap.set(objectId, existing);
	}

	return { branchMap, tagMap };
}

export interface GraphLayoutOptions {
	commits: ReadonlyArray<GitCommitEntry>;
	branches?: ReadonlyArray<GitBranchInfo>;
	/** Tags as "name:oid" strings */
	tags?: ReadonlyArray<string>;
}

/**
 * Compute graph layout for a list of commits.
 *
 * Returns an array of `GitGraphEntry` objects with column positions,
 * connection lines, and ref labels attached.
 */
export function computeGraphLayout(options: GraphLayoutOptions): GitGraphEntry[] {
	const { commits, branches = [], tags = [] } = options;
	const { branchMap, tagMap } = buildReferenceMaps(branches, tags, commits);
	const result: GitGraphEntry[] = [];

	// Active lanes: each lane tracks which OID it expects next
	const lanes: Array<Lane | undefined> = [];

	for (const commit of commits) {
		const connections: GitGraphConnection[] = [];

		// Find which lane(s) expect this commit
		let column = -1;
		const matchingLaneIndices: number[] = [];
		for (const [index, lane] of lanes.entries()) {
			if (lane?.expectedObjectId === commit.objectId) {
				matchingLaneIndices.push(index);
				if (column === -1) {
					column = index;
				}
			}
		}

		// If no lane expects this commit, allocate a new one
		if (column === -1) {
			column = findEmptyLane(lanes);
			if (column === -1) {
				column = lanes.length;
				lanes.push(undefined);
			}
		}

		// Close all duplicate lanes (merge connections)
		for (const laneIndex of matchingLaneIndices) {
			if (laneIndex !== column) {
				connections.push({
					fromColumn: laneIndex,
					toColumn: column,
					color: getColumnColor(lanes[laneIndex]?.colorColumn ?? laneIndex),
				});
				lanes[laneIndex] = undefined;
			}
		}

		// Assign parent OIDs to lanes
		const parentObjectIds = commit.parentObjectIds;

		if (parentObjectIds.length === 0) {
			// Root commit — clear this lane
			lanes[column] = undefined;
		} else {
			// First parent continues in this lane
			lanes[column] = {
				expectedObjectId: parentObjectIds[0],
				colorColumn: column,
			};
			connections.push({
				fromColumn: column,
				toColumn: column,
				color: getColumnColor(column),
			});

			// Additional parents get new lanes (merge commits)
			for (let parentIndex = 1; parentIndex < parentObjectIds.length; parentIndex++) {
				const parentObjectId = parentObjectIds[parentIndex];

				// Check if any existing lane already expects this parent
				const existingLane = lanes.findIndex((lane) => lane !== undefined && lane.expectedObjectId === parentObjectId);

				if (existingLane === -1) {
					// Allocate a new lane
					let newLane = findEmptyLane(lanes);
					if (newLane === -1) {
						newLane = lanes.length;
						lanes.push(undefined);
					}
					lanes[newLane] = {
						expectedObjectId: parentObjectId,
						colorColumn: newLane,
					};
					connections.push({
						fromColumn: column,
						toColumn: newLane,
						color: getColumnColor(newLane),
					});
				} else {
					// Connect to existing lane
					connections.push({
						fromColumn: column,
						toColumn: existingLane,
						color: getColumnColor(lanes[existingLane]?.colorColumn ?? existingLane),
					});
				}
			}
		}

		result.push({
			...commit,
			column,
			connections,
			branchNames: branchMap.get(commit.objectId) ?? [],
			tagNames: tagMap.get(commit.objectId) ?? [],
		});
	}

	return result;
}

/**
 * Compute the maximum number of columns used in the graph.
 * Useful for sizing the SVG canvas width.
 * Returns 0 for an empty graph.
 */
export function getMaxColumns(entries: ReadonlyArray<GitGraphEntry>): number {
	if (entries.length === 0) {
		return 0;
	}

	let max = 0;
	for (const entry of entries) {
		if (entry.column > max) {
			max = entry.column;
		}
		for (const connection of entry.connections) {
			if (connection.fromColumn > max) {
				max = connection.fromColumn;
			}
			if (connection.toColumn > max) {
				max = connection.toColumn;
			}
		}
	}
	return max + 1;
}
