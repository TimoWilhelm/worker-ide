/**
 * Border Beam Component
 *
 * Renders an animated beam that travels along the border of a container.
 * Used to indicate background activity (e.g. AI code generation in progress).
 * Requires the `borderBeam` keyframes and `--border-beam-angle` @property
 * defined in index.css.
 */

import { cn } from '@/lib/utils';

import type { CSSProperties } from 'react';

interface BorderBeamProperties {
	className?: string;
	/** Duration of one full loop in seconds */
	duration?: number;
}

const beamStyle: CSSProperties = {
	animation: 'borderBeam var(--border-beam-duration, 2s) linear infinite',
	background:
		'conic-gradient(from var(--border-beam-angle), transparent 0%, transparent 70%, var(--color-accent) 85%, var(--color-accent-hover) 92%, transparent 100%)',
	mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
	maskComposite: 'exclude',
	padding: '1.5px',
};

function BorderBeam({ className, duration = 2 }: BorderBeamProperties) {
	return (
		<div className={cn('pointer-events-none absolute inset-0 overflow-hidden rounded-[inherit]', className)}>
			<div
				className="absolute inset-0"
				style={{
					...beamStyle,
					animationDuration: `${duration}s`,
				}}
			/>
		</div>
	);
}

export { BorderBeam };
export type { BorderBeamProperties };
