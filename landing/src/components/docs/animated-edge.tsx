import { BaseEdge, type Edge, type EdgeProps, getBezierPath } from '@xyflow/react';
import type { JSX } from 'react';

interface AnimatedEdgeData {
	color: string;
	[key: string]: unknown;
}

export default function AnimatedEdge({
	id,
	sourceX,
	sourceY,
	targetX,
	targetY,
	sourcePosition,
	targetPosition,
	data,
}: EdgeProps<Edge<AnimatedEdgeData>>): JSX.Element {
	const color = data?.color ?? '#8b8b8b';

	const [edgePath] = getBezierPath({
		sourceX,
		sourceY,
		targetX,
		targetY,
		sourcePosition,
		targetPosition,
		curvature: 0.5,
	});

	return (
		<BaseEdge
			id={id}
			path={edgePath}
			style={{
				stroke: color,
				strokeWidth: 1.45,
				strokeDasharray: '8 4',
				animation: 'edge-dash-flow 1.25s linear infinite',
			}}
		/>
	);
}
