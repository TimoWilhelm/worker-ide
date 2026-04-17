import { useCallback, useEffect, useRef, useState } from 'react';

import { cn } from '@/lib/utils';

export interface ResizablePanelProperties {
	children: React.ReactNode;
	direction: 'horizontal' | 'vertical';
	defaultSize: number;
	minSize?: number;
	maxSize?: number;
	onSizeChange?: (size: number) => void;
	className?: string;
	handlePosition?: 'start' | 'end';
}
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
