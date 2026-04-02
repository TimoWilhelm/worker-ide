import type { FlowSection } from '../../data/docs-content';

const NODE_MIN_WIDTH = 160;
const NODE_MAX_WIDTH = 228;
const NODE_MIN_HEIGHT = 76;
const HORIZONTAL_PADDING = 20;
const VERTICAL_PADDING = 16;
const HORIZONTAL_GAP = 44;
const VERTICAL_GAP = 20;

interface LayoutNode {
	id: string;
	x: number;
	y: number;
	width: number;
	height: number;
	name: string;
	detail: string;
	incomingSummary?: string;
	color: string;
}

interface LayoutEdge {
	id: string;
	sourceId: string;
	targetId: string;
	color: string;
}

interface LayoutResult {
	nodes: LayoutNode[];
	edges: LayoutEdge[];
	totalHeight: number;
}

function assignColumns(section: FlowSection): Map<string, number> {
	const incomingCount = new Map<string, number>();
	const outgoing = new Map<string, string[]>();

	for (const node of section.nodes) {
		incomingCount.set(node.id, 0);
		outgoing.set(node.id, []);
	}

	for (const edge of section.edges) {
		if (!incomingCount.has(edge.source) || !incomingCount.has(edge.target)) {
			continue;
		}
		incomingCount.set(edge.target, (incomingCount.get(edge.target) ?? 0) + 1);
		outgoing.get(edge.source)?.push(edge.target);
	}

	const queue: Array<{ nodeId: string; depth: number }> = [];
	for (const [nodeId, count] of incomingCount.entries()) {
		if (count === 0) {
			queue.push({ nodeId, depth: 0 });
		}
	}

	const columns = new Map<string, number>();
	const visited = new Set<string>();

	while (queue.length > 0) {
		const current = queue.shift();
		if (current === undefined || visited.has(current.nodeId)) {
			continue;
		}

		columns.set(current.nodeId, current.depth);
		visited.add(current.nodeId);

		for (const child of outgoing.get(current.nodeId) ?? []) {
			queue.push({ nodeId: child, depth: current.depth + 1 });
		}
	}

	for (const node of section.nodes) {
		if (!columns.has(node.id)) {
			columns.set(node.id, 0);
		}
	}

	return columns;
}

function estimateLineCount(text: string, charsPerLine: number): number {
	if (text.length === 0) {
		return 0;
	}
	return Math.max(1, Math.ceil(text.length / Math.max(10, charsPerLine)));
}

function buildIncomingSummary(section: FlowSection): Map<string, string | undefined> {
	const labelsByTarget = new Map<string, string[]>();
	for (const edge of section.edges) {
		const existing = labelsByTarget.get(edge.target) ?? [];
		existing.push(edge.label);
		labelsByTarget.set(edge.target, existing);
	}

	const summaries = new Map<string, string | undefined>();
	for (const node of section.nodes) {
		const labels = labelsByTarget.get(node.id);
		if (labels === undefined || labels.length === 0) {
			summaries.set(node.id, undefined);
			continue;
		}
		summaries.set(node.id, labels.join(' | '));
	}

	return summaries;
}

export function computeSectionLayout(section: FlowSection, containerWidth: number): LayoutResult {
	const columns = assignColumns(section);
	const maxColumn = Math.max(0, ...columns.values());
	const columnCount = maxColumn + 1;

	const availableWidth = Math.max(420, containerWidth - HORIZONTAL_PADDING * 2);
	const preferredWidth = Math.floor((availableWidth - HORIZONTAL_GAP * (columnCount - 1)) / columnCount);
	const nodeWidth = Math.max(NODE_MIN_WIDTH, Math.min(NODE_MAX_WIDTH, preferredWidth));
	const charsPerLine = Math.floor((nodeWidth - 24) / 7.1);

	const incomingSummaryByNode = buildIncomingSummary(section);

	const groupsByColumn = new Map<number, typeof section.nodes>();
	for (let index = 0; index < columnCount; index += 1) {
		groupsByColumn.set(index, []);
	}

	for (const node of section.nodes) {
		const column = columns.get(node.id) ?? 0;
		groupsByColumn.get(column)?.push(node);
	}

	const nodeHeightById = new Map<string, number>();
	for (const node of section.nodes) {
		const incomingSummary = incomingSummaryByNode.get(node.id) ?? '';
		const nameLines = estimateLineCount(node.name, charsPerLine);
		const detailLines = estimateLineCount(node.detail, charsPerLine);
		const summaryLines = estimateLineCount(incomingSummary, charsPerLine);
		const dynamicHeight = 24 + nameLines * 16 + detailLines * 14 + summaryLines * 13;
		nodeHeightById.set(node.id, Math.max(NODE_MIN_HEIGHT, dynamicHeight));
	}

	let totalHeight = VERTICAL_PADDING * 2;
	for (let column = 0; column < columnCount; column += 1) {
		const columnNodes = groupsByColumn.get(column) ?? [];
		let columnHeight = 0;
		for (const [index, node] of columnNodes.entries()) {
			columnHeight += nodeHeightById.get(node.id) ?? NODE_MIN_HEIGHT;
			if (index < columnNodes.length - 1) {
				columnHeight += VERTICAL_GAP;
			}
		}
		totalHeight = Math.max(totalHeight, VERTICAL_PADDING * 2 + columnHeight);
	}

	const nodes: LayoutNode[] = [];
	const nodeCoordinates = new Map<string, { x: number; y: number }>();

	for (let column = 0; column < columnCount; column += 1) {
		const columnNodes = groupsByColumn.get(column) ?? [];
		const columnX = HORIZONTAL_PADDING + column * (nodeWidth + HORIZONTAL_GAP);

		let columnContentHeight = 0;
		for (const [index, node] of columnNodes.entries()) {
			columnContentHeight += nodeHeightById.get(node.id) ?? NODE_MIN_HEIGHT;
			if (index < columnNodes.length - 1) {
				columnContentHeight += VERTICAL_GAP;
			}
		}

		let currentY = Math.max(VERTICAL_PADDING, (totalHeight - columnContentHeight) / 2);

		for (const node of columnNodes) {
			const nodeHeight = nodeHeightById.get(node.id) ?? NODE_MIN_HEIGHT;
			nodes.push({
				id: node.id,
				x: columnX,
				y: currentY,
				width: nodeWidth,
				height: nodeHeight,
				name: node.name,
				detail: node.detail,
				incomingSummary: incomingSummaryByNode.get(node.id),
				color: node.color,
			});
			nodeCoordinates.set(node.id, { x: columnX, y: currentY });
			currentY += nodeHeight + VERTICAL_GAP;
		}
	}

	const edges: LayoutEdge[] = [];
	for (const edge of section.edges) {
		if (!nodeCoordinates.has(edge.source) || !nodeCoordinates.has(edge.target)) {
			continue;
		}
		edges.push({
			id: edge.id,
			sourceId: edge.source,
			targetId: edge.target,
			color: edge.color,
		});
	}

	return {
		nodes,
		edges,
		totalHeight,
	};
}
