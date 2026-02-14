/**
 * Resizable Panel Component
 *
 * A container with a draggable resize handle.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

// =============================================================================
// Types
// =============================================================================

export interface ResizablePanelProperties {
	/** Panel content */
	children: React.ReactNode;
	/** Direction of the resize handle */
	direction: 'horizontal' | 'vertical';
	/** Initial size in pixels */
	defaultSize: number;
	/** Minimum size in pixels */
	minSize?: number;
	/** Maximum size in pixels */
	maxSize?: number;
	/** Called when size changes */
	onSizeChange?: (size: number) => void;
	/** CSS class name */
	className?: string;
	/** Whether resize handle is on the start or end */
	handlePosition?: 'start' | 'end';
}

// =============================================================================
// Component
// =============================================================================

/**
 * Resizable panel with draggable handle.
 */
export function ResizablePanel({
	children,
	direction,
	defaultSize,
	minSize = 100,
	maxSize = 800,
	onSizeChange,
	className,
	handlePosition = 'end',
}: ResizablePanelProperties) {
	const [size, setSize] = useState(defaultSize);
	const [isResizing, setIsResizing] = useState(false);
	const panelReference = useRef<HTMLDivElement>(null);
	const startPositionReference = useRef(0);
	const startSizeReference = useRef(0);

	// Handle mouse down on resize handle
	const handleMouseDown = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault();
			setIsResizing(true);
			startPositionReference.current = direction === 'horizontal' ? event.clientX : event.clientY;
			startSizeReference.current = size;
		},
		[direction, size],
	);

	// Handle mouse move during resize
	useEffect(() => {
		if (!isResizing) return;

		const handleMouseMove = (event: MouseEvent) => {
			const currentPosition = direction === 'horizontal' ? event.clientX : event.clientY;
			const delta = currentPosition - startPositionReference.current;

			// Invert delta if handle is at start
			const adjustedDelta = handlePosition === 'start' ? -delta : delta;

			const newSize = Math.min(maxSize, Math.max(minSize, startSizeReference.current + adjustedDelta));
			setSize(newSize);
			onSizeChange?.(newSize);
		};

		const handleMouseUp = () => {
			setIsResizing(false);
		};

		document.addEventListener('mousemove', handleMouseMove);
		document.addEventListener('mouseup', handleMouseUp);

		return () => {
			document.removeEventListener('mousemove', handleMouseMove);
			document.removeEventListener('mouseup', handleMouseUp);
		};
	}, [isResizing, direction, minSize, maxSize, onSizeChange, handlePosition]);

	// Prevent text selection during resize
	useEffect(() => {
		if (isResizing) {
			document.body.style.userSelect = 'none';
			document.body.style.cursor = direction === 'horizontal' ? 'col-resize' : 'row-resize';
		} else {
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
		}

		return () => {
			document.body.style.userSelect = '';
			document.body.style.cursor = '';
		};
	}, [isResizing, direction]);

	const isHorizontal = direction === 'horizontal';
	const sizeStyle = isHorizontal ? { width: size } : { height: size };

	const handleClasses = cn(
		`
			shrink-0 bg-border transition-colors
			hover:bg-accent
		`,
		isHorizontal ? 'w-1 cursor-col-resize' : 'h-1 cursor-row-resize',
		isResizing && 'bg-accent',
	);

	return (
		<div ref={panelReference} className={cn('relative flex shrink-0', isHorizontal ? 'flex-row' : 'flex-col', className)} style={sizeStyle}>
			{handlePosition === 'start' && <div className={handleClasses} onMouseDown={handleMouseDown} />}
			<div className="flex-1 overflow-hidden">{children}</div>
			{handlePosition === 'end' && <div className={handleClasses} onMouseDown={handleMouseDown} />}
		</div>
	);
}

// =============================================================================
// Panel Group Component
// =============================================================================

export interface PanelGroupProperties {
	/** Panel content */
	children: React.ReactNode;
	/** Direction of the panel group */
	direction: 'horizontal' | 'vertical';
	/** CSS class name */
	className?: string;
}

/**
 * Container for resizable panels.
 */
export function PanelGroup({ children, direction, className }: PanelGroupProperties) {
	return <div className={cn('flex', direction === 'horizontal' ? 'flex-row' : 'flex-col', className)}>{children}</div>;
}
