/**
 * Halftone Background Component
 *
 * Full-screen WebGL2 canvas that renders an animated halftone dot pattern
 * with a fire-like warm glow emanating from the bottom of the screen.
 * Adapts to light/dark mode by reading CSS custom properties.
 *
 * This component is lazy-loaded via React.lazy() to avoid increasing
 * the initial bundle size. No external dependencies — pure WebGL2.
 */

import { useEffect, useRef } from 'react';

import fragmentShaderSource from './shaders/halftone.frag.glsl?raw';
import vertexShaderSource from './shaders/halftone.vert.glsl?raw';

// =============================================================================
// WebGL Helpers
// =============================================================================

function createShader(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | undefined {
	const shader = gl.createShader(type);
	if (!shader) return undefined;
	gl.shaderSource(shader, source);
	gl.compileShader(shader);
	if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
		console.error('Shader compile error:', gl.getShaderInfoLog(shader));
		gl.deleteShader(shader);
		return undefined;
	}
	return shader;
}

function createProgram(gl: WebGL2RenderingContext, vertexShader: WebGLShader, fragmentShader: WebGLShader): WebGLProgram | undefined {
	const program = gl.createProgram();
	if (!program) return undefined;
	gl.attachShader(program, vertexShader);
	gl.attachShader(program, fragmentShader);
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
		console.error('Program link error:', gl.getProgramInfoLog(program));
		gl.deleteProgram(program);
		return undefined;
	}
	return program;
}

// =============================================================================
// Color Helpers
// =============================================================================

/**
 * Offscreen canvas context used to resolve arbitrary CSS color values
 * (hex, oklch, rgb, hsl, etc.) into concrete RGB components.
 *
 * This avoids having to write parsers for every color format.
 * The canvas context's `fillStyle` setter normalises any valid CSS color
 * to a `#rrggbb` or `rgba(...)` string which we can then read back.
 *
 * Created lazily and reused across calls for the lifetime of the page.
 */
let colorProbeContext: CanvasRenderingContext2D | undefined;

function getColorProbeContext(): CanvasRenderingContext2D | undefined {
	if (colorProbeContext) return colorProbeContext;
	const canvas = document.createElement('canvas');
	canvas.width = 1;
	canvas.height = 1;
	const context = canvas.getContext('2d', { willReadFrequently: true });
	if (context) {
		colorProbeContext = context;
	}
	return colorProbeContext;
}

/**
 * Resolve any CSS color string to normalised [r, g, b] floats in 0..1.
 *
 * Works by setting the color as `fillStyle` on a tiny offscreen canvas,
 * filling a single pixel, then reading back the pixel data. This lets the
 * browser's color engine handle all parsing (hex, oklch, rgb, hsl, …).
 */
function resolveColorToRgb(cssColor: string, fallback: [number, number, number]): [number, number, number] {
	const context = getColorProbeContext();
	if (!context) return fallback;

	// fillRect + getImageData is the most reliable way to resolve a color
	context.clearRect(0, 0, 1, 1);
	context.fillStyle = cssColor;
	context.fillRect(0, 0, 1, 1);
	const pixel = context.getImageData(0, 0, 1, 1).data;
	return [pixel[0] / 255, pixel[1] / 255, pixel[2] / 255];
}

/**
 * Read a CSS custom property value from the document root.
 */
function getCssVariable(name: string): string {
	return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// =============================================================================
// Component
// =============================================================================

interface WebGLContext {
	gl: WebGL2RenderingContext;
	program: WebGLProgram;
	uniforms: {
		time: WebGLUniformLocation | null;
		resolution: WebGLUniformLocation | null;
		colorAccent: WebGLUniformLocation | null;
		colorBackground: WebGLUniformLocation | null;
		dotScale: WebGLUniformLocation | null;
		fadeIn: WebGLUniformLocation | null;
	};
}

/**
 * Initialize WebGL2 context, compile shaders, and set up the fullscreen quad.
 * Defined outside the component to satisfy react-compiler rules.
 */
function setupWebGL(canvas: HTMLCanvasElement): WebGLContext | undefined {
	const gl = canvas.getContext('webgl2', {
		alpha: false,
		antialias: false,
		premultipliedAlpha: false,
	});
	if (!gl) {
		console.warn('WebGL2 not available for halftone background');
		return undefined;
	}

	const vertexShader = createShader(gl, gl.VERTEX_SHADER, vertexShaderSource);
	const fragmentShader = createShader(gl, gl.FRAGMENT_SHADER, fragmentShaderSource);
	if (!vertexShader || !fragmentShader) return undefined;

	const program = createProgram(gl, vertexShader, fragmentShader);
	if (!program) return undefined;

	// Full-screen quad (two triangles)
	const vertices = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);
	const buffer = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
	gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

	const positionLocation = gl.getAttribLocation(program, 'position');
	gl.enableVertexAttribArray(positionLocation);
	gl.vertexAttribPointer(positionLocation, 2, gl.FLOAT, false, 0, 0);

	gl.useProgram(program);

	return {
		gl,
		program,
		uniforms: {
			time: gl.getUniformLocation(program, 'uTime'),
			resolution: gl.getUniformLocation(program, 'uResolution'),
			colorAccent: gl.getUniformLocation(program, 'uColorAccent'),
			colorBackground: gl.getUniformLocation(program, 'uColorBackground'),
			dotScale: gl.getUniformLocation(program, 'uDotScale'),
			fadeIn: gl.getUniformLocation(program, 'uFadeIn'),
		},
	};
}

/** Default accent color (dark mode orange) as normalised RGB */
const DEFAULT_ACCENT: [number, number, number] = [0.945, 0.275, 0.008];
/** Default background color (dark mode near-black) as normalised RGB */
const DEFAULT_BACKGROUND: [number, number, number] = [0.071, 0.071, 0.071];

/**
 * Full-screen halftone background canvas.
 * Renders a fire-like glow from the bottom using a WebGL2 halftone shader.
 * Automatically adapts to theme changes by reading CSS custom properties.
 */
export function HalftoneBackground() {
	const canvasReference = useRef<HTMLCanvasElement>(null);
	const animationFrameReference = useRef<number>(0);
	const startTimeReference = useRef<number>(0);

	useEffect(() => {
		const canvas = canvasReference.current;
		if (!canvas) return;

		let webGLContext: WebGLContext | undefined;
		let disposed = false;

		// Animation loop — defined before ResizeObserver so it can be
		// referenced in the first-resize callback without TDZ issues.
		const render = () => {
			if (disposed || !webGLContext) return;
			const { gl, uniforms } = webGLContext;

			const elapsed = (performance.now() - startTimeReference.current) / 1000;

			// Read theme colors each frame to adapt to theme changes.
			// resolveColorToRgb handles any CSS color format (hex, oklch, etc.)
			const accentRaw = getCssVariable('--color-accent');
			const backgroundRaw = getCssVariable('--color-bg-primary');
			const accentRgb = accentRaw ? resolveColorToRgb(accentRaw, DEFAULT_ACCENT) : DEFAULT_ACCENT;
			const backgroundRgb = backgroundRaw ? resolveColorToRgb(backgroundRaw, DEFAULT_BACKGROUND) : DEFAULT_BACKGROUND;

			// Dot density: canvas pixels / ~12px per cell (matching Cloudflare dot grid)
			const dotScale = Math.round(canvas.height / 12);

			// Fade-in over 2 seconds, clamped at 1.0
			const fadeIn = Math.min(elapsed / 2, 1);

			gl.uniform1f(uniforms.time, elapsed);
			gl.uniform2f(uniforms.resolution, canvas.width, canvas.height);
			gl.uniform3f(uniforms.colorAccent, accentRgb[0], accentRgb[1], accentRgb[2]);
			gl.uniform3f(uniforms.colorBackground, backgroundRgb[0], backgroundRgb[1], backgroundRgb[2]);
			gl.uniform1f(uniforms.dotScale, dotScale);
			gl.uniform1f(uniforms.fadeIn, fadeIn);

			gl.drawArrays(gl.TRIANGLES, 0, 6);

			animationFrameReference.current = requestAnimationFrame(render);
		};

		// Handle canvas resize with ResizeObserver.
		// WebGL setup is deferred until the canvas has real dimensions —
		// a 0×0 canvas produces a broken WebGL context on some drivers.
		const resizeObserver = new ResizeObserver((entries) => {
			if (disposed) return;
			for (const entry of entries) {
				const { width, height } = entry.contentRect;
				if (width === 0 || height === 0) continue;

				const dpr = Math.min(globalThis.devicePixelRatio || 1, 2);
				canvas.width = Math.round(width * dpr);
				canvas.height = Math.round(height * dpr);

				// First resize: set up WebGL now that the canvas has real dimensions
				if (!webGLContext) {
					webGLContext = setupWebGL(canvas);
					if (!webGLContext) return;
					startTimeReference.current = performance.now();
					animationFrameReference.current = requestAnimationFrame(render);
				}

				const { gl } = webGLContext;
				gl.viewport(0, 0, canvas.width, canvas.height);

				// Immediately clear to background color to prevent black flash on resize
				const backgroundRaw = getCssVariable('--color-bg-primary');
				const bg = backgroundRaw ? resolveColorToRgb(backgroundRaw, DEFAULT_BACKGROUND) : DEFAULT_BACKGROUND;
				gl.clearColor(bg[0], bg[1], bg[2], 1);
				gl.clear(gl.COLOR_BUFFER_BIT);
			}
		});
		resizeObserver.observe(canvas);

		return () => {
			disposed = true;
			cancelAnimationFrame(animationFrameReference.current);
			resizeObserver.disconnect();
			webGLContext?.gl.getExtension('WEBGL_lose_context')?.loseContext();
		};
	}, []);

	return (
		<canvas
			ref={canvasReference}
			className="fixed inset-0 -z-10 size-full bg-bg-primary"
			aria-hidden="true"
			style={{ imageRendering: 'pixelated' }}
		/>
	);
}
