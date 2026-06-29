/**
 * Stand-in for optional dependencies that vinext dynamically imports but that
 * are not bundled into the Vite Surface Host runtime (e.g. `@mdx-js/rollup`).
 *
 * vinext wraps these `import(...)` calls in try/catch and degrades gracefully
 * when they are absent. Throwing on evaluation reproduces the "not installed"
 * path deterministically, and — because the dynamic import resolves to this
 * inlined module — avoids the host loader treating an unresolved bare specifier
 * as a fatal error.
 */
export const unavailableReason = 'Optional dependency is not available in the Vite Surface Host runtime';

throw new Error(unavailableReason);
