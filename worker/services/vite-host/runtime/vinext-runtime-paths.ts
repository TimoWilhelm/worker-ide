/**
 * Deterministic virtual roots vinext resolves its runtime modules against.
 *
 * Must match `VINEXT_RUNTIME_DIRNAME` in `scripts/vendor-vite-host.ts`, which
 * pins `import.meta.dirname` in the vendored plugin bundle. vinext references
 * runtime files both relative to that dirname and one level above it.
 */
export const VINEXT_RUNTIME_DIST_ROOT = '/__vinext__/dist';
export const VINEXT_RUNTIME_ROOT = '/__vinext__';
