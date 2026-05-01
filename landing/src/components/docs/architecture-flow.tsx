import {
	Controls,
	Handle,
	Position,
	ReactFlow,
	ReactFlowProvider,
	useReactFlow,
	type CoordinateExtent,
	type Edge,
	type Node,
	type NodeProps,
	type ReactFlowInstance,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { type JSX, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FlowSection } from '../../data/docs-content';
import AnimatedEdge from './animated-edge';
import { computeFlowCanvasHeight, computeSectionLayout } from './compute-docs-layout';

const COLOR_MAP: Record<string, string> = {
	text: '#f0e3de',
	orange: '#ff8c5a',
	magenta: '#ff70d0',
	yellow: '#ffd060',
	red: '#ff7070',
	accent: '#f14602',
	ws: '#7dff6a',
	worker: '#c490ff',
	asset: '#5cc8ff',
	cyan: '#56d6ff',
	emerald: '#50e8a0',
	ai: '#ffb347',
	test: '#ff6b9d',
	deploy: '#4ecdc4',
	snapshot: '#b8a9e8',
	collab: '#6ec6ff',
};

function resolveColor(color: string): string {
	return COLOR_MAP[color] ?? color;
}

const POSITION_MAP: Record<string, Position> = {
	left: Position.Left,
	right: Position.Right,
	top: Position.Top,
	bottom: Position.Bottom,
};

const hiddenHandleStyle: React.CSSProperties = {
	width: 1,
	height: 1,
	background: 'transparent',
	border: 'none',
	minWidth: 0,
	minHeight: 0,
	opacity: 0,
};

interface HandleSpec {
	id: string;
	type: 'source' | 'target';
	position: Position;
	style: React.CSSProperties;
}

interface SystemNodeData {
	name: string;
	detail: string;
	incomingSummary?: string;
	color: string;
	width: number;
	height: number;
	handles: HandleSpec[];
	[key: string]: unknown;
}

function SystemNode({ data }: NodeProps<Node<SystemNodeData>>): JSX.Element {
	const color = data.color;
	const width = typeof data.width === 'number' ? data.width : 180;
	const handles: HandleSpec[] = Array.isArray(data.handles) ? data.handles : [];

	return (
		<div
			style={{
				width,
				minHeight: typeof data.height === 'number' ? data.height : 76,
				padding: '10px 14px',
				borderRadius: 10,
				border: `1.5px solid ${color}55`,
				background: `color-mix(in srgb, ${color} 8%, #1a1917)`,
				display: 'flex',
				flexDirection: 'column',
				justifyContent: 'center',
				gap: 4,
				textAlign: 'center',
				position: 'relative',
				boxShadow: `0 0 12px ${color}18`,
			}}
		>
			{handles.map((handle) => (
				<Handle key={handle.id} type={handle.type} position={handle.position} id={handle.id} style={handle.style} />
			))}
			<span
				style={{
					fontFamily: "'Space Mono', monospace",
					fontSize: '13px',
					fontWeight: 600,
					letterSpacing: '0.01em',
					color,
					whiteSpace: 'normal',
					overflowWrap: 'anywhere',
					lineHeight: 1.2,
				}}
			>
				{data.name}
			</span>
			<span
				style={{
					fontSize: '11px',
					color: '#fffdfb88',
					lineHeight: 1.35,
					whiteSpace: 'normal',
					overflowWrap: 'anywhere',
				}}
			>
				{data.detail}
			</span>
			{data.incomingSummary && (
				<span
					style={{
						fontSize: '10px',
						color: `${color}cc`,
						lineHeight: 1.2,
						whiteSpace: 'normal',
						overflowWrap: 'anywhere',
						fontFamily: "'Space Mono', monospace",
					}}
				>
					{data.incomingSummary}
				</span>
			)}
		</div>
	);
}

const nodeTypes = {
	'system-node': SystemNode,
};

const edgeTypes = {
	animated: AnimatedEdge,
};

const TRANSLATE_PADDING = 180;

// ── Handle computation: spread multiple connections along a side ──

interface EdgeHandleAssignment {
	edgeId: string;
	sourceId: string;
	targetId: string;
	sourceHandleId: string;
	targetHandleId: string;
	color: string;
}

interface HandleAssignmentResult {
	edges: EdgeHandleAssignment[];
	handlesByNode: Map<string, HandleSpec[]>;
}

function computeOffset(index: number, total: number, side: string): React.CSSProperties {
	if (total <= 1) {
		return { ...hiddenHandleStyle };
	}

	// Spread handles between 25% and 75% of the side
	const fraction = 0.25 + (0.5 * index) / (total - 1);
	const percent = `${(fraction * 100).toFixed(1)}%`;

	if (side === 'left' || side === 'right') {
		return { ...hiddenHandleStyle, top: percent };
	}
	return { ...hiddenHandleStyle, left: percent };
}

function computeHandleAssignments(
	layoutEdges: Array<{ id: string; sourceId: string; targetId: string; color: string }>,
	nodePositions: Map<string, { x: number; y: number }>,
): HandleAssignmentResult {
	// Group edges by (nodeId, side, type)
	const sourceSlots = new Map<string, string[]>(); // "nodeId:side" -> edgeIds
	const targetSlots = new Map<string, string[]>();
	const edgeSides = new Map<string, { sourceSide: string; targetSide: string }>();

	for (const edge of layoutEdges) {
		const sourcePosition = nodePositions.get(edge.sourceId);
		const targetPosition = nodePositions.get(edge.targetId);

		let sourceSide = 'right';
		let targetSide = 'left';

		if (sourcePosition !== undefined && targetPosition !== undefined) {
			const deltaX = targetPosition.x - sourcePosition.x;
			const deltaY = targetPosition.y - sourcePosition.y;

			if (Math.abs(deltaX) >= Math.abs(deltaY)) {
				if (deltaX >= 0) {
					sourceSide = 'right';
					targetSide = 'left';
				} else {
					sourceSide = 'left';
					targetSide = 'right';
				}
			} else {
				if (deltaY >= 0) {
					sourceSide = 'bottom';
					targetSide = 'top';
				} else {
					sourceSide = 'top';
					targetSide = 'bottom';
				}
			}
		}

		edgeSides.set(edge.id, { sourceSide, targetSide });

		const sourceKey = `${edge.sourceId}:${sourceSide}`;
		const targetKey = `${edge.targetId}:${targetSide}`;

		const sourceList = sourceSlots.get(sourceKey) ?? [];
		sourceList.push(edge.id);
		sourceSlots.set(sourceKey, sourceList);

		const targetList = targetSlots.get(targetKey) ?? [];
		targetList.push(edge.id);
		targetSlots.set(targetKey, targetList);
	}

	// Build per-edge handle IDs and per-node handle specs
	const handlesByNode = new Map<string, HandleSpec[]>();
	const edgeAssignments: EdgeHandleAssignment[] = [];

	function ensureNodeHandles(nodeId: string): HandleSpec[] {
		let handles = handlesByNode.get(nodeId);
		if (handles === undefined) {
			handles = [];
			handlesByNode.set(nodeId, handles);
		}
		return handles;
	}

	for (const edge of layoutEdges) {
		const sides = edgeSides.get(edge.id);
		if (sides === undefined) continue;

		const sourceKey = `${edge.sourceId}:${sides.sourceSide}`;
		const targetKey = `${edge.targetId}:${sides.targetSide}`;

		const sourceEdgesOnSide = sourceSlots.get(sourceKey) ?? [];
		const targetEdgesOnSide = targetSlots.get(targetKey) ?? [];

		const sourceIndex = sourceEdgesOnSide.indexOf(edge.id);
		const targetIndex = targetEdgesOnSide.indexOf(edge.id);

		const sourceHandleId = `src-${edge.id}`;
		const targetHandleId = `tgt-${edge.id}`;

		const sourceHandles = ensureNodeHandles(edge.sourceId);
		sourceHandles.push({
			id: sourceHandleId,
			type: 'source',
			position: POSITION_MAP[sides.sourceSide] ?? Position.Right,
			style: computeOffset(Math.max(sourceIndex, 0), sourceEdgesOnSide.length, sides.sourceSide),
		});

		const targetHandles = ensureNodeHandles(edge.targetId);
		targetHandles.push({
			id: targetHandleId,
			type: 'target',
			position: POSITION_MAP[sides.targetSide] ?? Position.Left,
			style: computeOffset(Math.max(targetIndex, 0), targetEdgesOnSide.length, sides.targetSide),
		});

		edgeAssignments.push({
			edgeId: edge.id,
			sourceId: edge.sourceId,
			targetId: edge.targetId,
			sourceHandleId,
			targetHandleId,
			color: edge.color,
		});
	}

	return { edges: edgeAssignments, handlesByNode };
}

// ── Layout Flow component ────────────────────────────────

interface LayoutFlowProperties {
	section: FlowSection;
}

function LayoutFlow({ section }: LayoutFlowProperties): JSX.Element {
	const { fitView } = useReactFlow();
	const [containerWidth, setContainerWidth] = useState(900);
	const [hasInitialized, setHasInitialized] = useState(false);
	const containerReference = useRef<HTMLDivElement | null>(null);
	const instanceReference = useRef<ReactFlowInstance | undefined>(undefined);

	useEffect(() => {
		const container = containerReference.current;
		if (container === null) {
			return;
		}

		const observer = new ResizeObserver((entries) => {
			const entry = entries.at(0);
			if (entry !== undefined) {
				setContainerWidth(Math.floor(entry.contentRect.width));
			}
		});

		observer.observe(container);
		return () => observer.disconnect();
	}, []);

	const layoutResult = useMemo(() => computeSectionLayout(section, containerWidth), [section, containerWidth]);

	const nodePositionById = useMemo(() => {
		const positionById = new Map<string, { x: number; y: number }>();
		for (const node of layoutResult.nodes) {
			positionById.set(node.id, { x: node.x, y: node.y });
		}
		return positionById;
	}, [layoutResult.nodes]);

	const handleAssignment = useMemo(
		() => computeHandleAssignments(layoutResult.edges, nodePositionById),
		[layoutResult.edges, nodePositionById],
	);
	const containerHeight = computeFlowCanvasHeight(layoutResult.totalHeight);

	const translateExtent = useMemo<CoordinateExtent>(() => {
		if (layoutResult.nodes.length === 0) {
			return [
				[-TRANSLATE_PADDING, -TRANSLATE_PADDING],
				[containerWidth + TRANSLATE_PADDING, containerHeight + TRANSLATE_PADDING],
			];
		}

		const minX = Math.min(...layoutResult.nodes.map((node) => node.x));
		const minY = Math.min(...layoutResult.nodes.map((node) => node.y));
		const maxX = Math.max(...layoutResult.nodes.map((node) => node.x + node.width));
		const maxY = Math.max(...layoutResult.nodes.map((node) => node.y + node.height));

		return [
			[Math.min(0, minX - TRANSLATE_PADDING), Math.min(0, minY - TRANSLATE_PADDING)],
			[Math.max(containerWidth, maxX + TRANSLATE_PADDING), Math.max(containerHeight, maxY + TRANSLATE_PADDING)],
		];
	}, [containerHeight, containerWidth, layoutResult.nodes]);

	const nodes = useMemo<Node[]>(() => {
		return layoutResult.nodes.map((node) => ({
			id: node.id,
			type: 'system-node',
			position: { x: node.x, y: node.y },
			data: {
				name: node.name,
				detail: node.detail,
				incomingSummary: node.incomingSummary,
				color: resolveColor(node.color),
				width: node.width,
				height: node.height,
				handles: handleAssignment.handlesByNode.get(node.id) ?? [],
			},
			width: node.width,
			height: node.height,
		}));
	}, [layoutResult.nodes, handleAssignment.handlesByNode]);

	const edges = useMemo<Edge[]>(() => {
		return handleAssignment.edges.map((edge) => ({
			id: edge.edgeId,
			source: edge.sourceId,
			target: edge.targetId,
			sourceHandle: edge.sourceHandleId,
			targetHandle: edge.targetHandleId,
			type: 'animated',
			data: {
				color: resolveColor(edge.color),
			},
		}));
	}, [handleAssignment.edges]);

	const handleInit = useCallback(
		(instance: ReactFlowInstance) => {
			instanceReference.current = instance;
			globalThis.requestAnimationFrame(() => {
				fitView({ padding: 0.06, minZoom: 0.35, maxZoom: 1.25 });
				setHasInitialized(true);
			});
		},
		[fitView],
	);

	useEffect(() => {
		if (!hasInitialized || instanceReference.current === undefined) {
			return;
		}

		globalThis.requestAnimationFrame(() => {
			fitView({ padding: 0.06, minZoom: 0.35, maxZoom: 1.25 });
		});
	}, [fitView, hasInitialized, layoutResult]);

	return (
		<div ref={containerReference} className="docs-flow-canvas" style={{ width: '100%', height: `${containerHeight}px` }}>
			<ReactFlow
				nodes={nodes}
				edges={edges}
				nodeTypes={nodeTypes}
				edgeTypes={edgeTypes}
				onInit={handleInit}
				fitView
				fitViewOptions={{ padding: 0.06, minZoom: 0.35, maxZoom: 1.25 }}
				minZoom={0.35}
				maxZoom={1.6}
				translateExtent={translateExtent}
				panOnDrag
				zoomOnScroll
				zoomOnPinch
				zoomOnDoubleClick
				nodesDraggable={false}
				nodesConnectable={false}
				elementsSelectable={false}
				preventScrolling={false}
				proOptions={{ hideAttribution: true }}
				colorMode="dark"
			>
				<Controls showInteractive={false} position="bottom-right" />
			</ReactFlow>
		</div>
	);
}

interface ArchitectureFlowProperties {
	section: FlowSection;
}

export default function ArchitectureFlow({ section }: ArchitectureFlowProperties): JSX.Element {
	return (
		<ReactFlowProvider>
			<LayoutFlow section={section} />
		</ReactFlowProvider>
	);
}
