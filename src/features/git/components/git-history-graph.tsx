/**
 * Git History Graph
 *
 * SVG visualization of the commit graph with branch lines and commit dots.
 * Rendered alongside the commit list.
 */

import { COLUMN_WIDTH, COMMIT_RADIUS, ROW_HEIGHT, getMaxColumns } from '../lib/git-graph-layout';

import type { GitGraphEntry } from '@shared/types';

// =============================================================================
// Types
// =============================================================================

interface GitHistoryGraphProperties {
	entries: GitGraphEntry[];
}

// =============================================================================
// Helpers
// =============================================================================

function getColumnX(column: number): number {
	return column * COLUMN_WIDTH + COLUMN_WIDTH / 2;
}

function getRowY(rowIndex: number): number {
	return rowIndex * ROW_HEIGHT + ROW_HEIGHT / 2;
}

// =============================================================================
// Component
// =============================================================================

export function GitHistoryGraph({ entries }: GitHistoryGraphProperties) {
	const maxColumns = getMaxColumns(entries);
	const width = maxColumns * COLUMN_WIDTH + COLUMN_WIDTH;
	const height = entries.length * ROW_HEIGHT;

	if (entries.length === 0) {
		return;
	}

	return (
		<svg width={width} height={height} className="shrink-0" style={{ minWidth: width }}>
			{/* Connection lines */}
			{entries.map((entry, rowIndex) =>
				entry.connections.map((connection, connectionIndex) => {
					const fromX = getColumnX(connection.fromColumn);
					const fromY = getRowY(rowIndex);
					const toX = getColumnX(connection.toColumn);
					const toY = getRowY(rowIndex + 1);

					// Curved line for diagonal connections, straight for vertical
					if (fromX === toX) {
						return (
							<line
								key={`${entry.objectId}-${connectionIndex}`}
								x1={fromX}
								y1={fromY}
								x2={toX}
								y2={toY}
								stroke={connection.color}
								strokeWidth={2}
								strokeOpacity={0.7}
							/>
						);
					}

					// Bezier curve for branch/merge lines
					const midY = (fromY + toY) / 2;
					return (
						<path
							key={`${entry.objectId}-${connectionIndex}`}
							d={`M ${fromX} ${fromY} C ${fromX} ${midY}, ${toX} ${midY}, ${toX} ${toY}`}
							stroke={connection.color}
							strokeWidth={2}
							strokeOpacity={0.7}
							fill="none"
						/>
					);
				}),
			)}

			{/* Commit dots */}
			{entries.map((entry, rowIndex) => {
				const centerX = getColumnX(entry.column);
				const centerY = getRowY(rowIndex);
				const color = entry.connections[0]?.color ?? '#888';

				return (
					<circle
						key={entry.objectId}
						cx={centerX}
						cy={centerY}
						r={COMMIT_RADIUS}
						fill={color}
						stroke="var(--color-bg-secondary)"
						strokeWidth={1.5}
					/>
				);
			})}
		</svg>
	);
}
