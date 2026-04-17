import { useEffect, useRef } from 'react';

import { cn } from '@/lib/utils';
const BAR_COUNT = 32;
const MIN_BAR_FRACTION = 0.1;
const AMPLITUDE_CURVE = 0.35;

export function AudioWaveform({ amplitudes, className }: { amplitudes: number[]; className?: string }) {
	const canvasReference = useRef<HTMLCanvasElement>(null);
	const animationFrameReference = useRef(0);

	useEffect(() => {
		const canvas = canvasReference.current;
		if (!canvas) return;

		const context = canvas.getContext('2d');
		if (!context) return;

		const draw = () => {
			const dpr = globalThis.devicePixelRatio || 1;
			const rect = canvas.getBoundingClientRect();
			const width = rect.width * dpr;
			const height = rect.height * dpr;

			if (canvas.width !== width || canvas.height !== height) {
				canvas.width = width;
				canvas.height = height;
			}

			context.clearRect(0, 0, width, height);

			const values = amplitudes.slice(-BAR_COUNT);
			const padCount = BAR_COUNT - values.length;

			const gap = 1.5 * dpr;
			const barWidth = (width - gap * (BAR_COUNT - 1)) / BAR_COUNT;
			const maxBarHeight = height * 0.85;

			const style = getComputedStyle(canvas);
			const color = style.getPropertyValue('--color-error').trim() || '#ef4444';

			context.fillStyle = color;

			for (let index = 0; index < BAR_COUNT; index++) {
				const raw = index < padCount ? 0 : values[index - padCount];
				const amplitude = raw > 0 ? Math.pow(raw, AMPLITUDE_CURVE) : 0;
				const barHeight = Math.max(maxBarHeight * amplitude, maxBarHeight * MIN_BAR_FRACTION);
				const x = index * (barWidth + gap);
				const y = (height - barHeight) / 2;

				const radius = Math.min(barWidth / 2, 2 * dpr);
				context.beginPath();
				context.roundRect(x, y, barWidth, barHeight, radius);
				context.fill();
			}

			animationFrameReference.current = requestAnimationFrame(draw);
		};

		animationFrameReference.current = requestAnimationFrame(draw);

		return () => {
			cancelAnimationFrame(animationFrameReference.current);
		};
	}, [amplitudes]);

	return (
		<canvas ref={canvasReference} className={cn('h-4 w-28 shrink-0', className)} style={{ imageRendering: 'pixelated' }} aria-hidden />
	);
}
