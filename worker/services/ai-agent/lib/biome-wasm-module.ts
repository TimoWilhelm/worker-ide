/**
 * Static WASM module import for the Biome linter.
 *
 * In the Cloudflare Workers runtime, `.wasm` imports are pre-compiled at deploy
 * time and resolve to a `WebAssembly.Module`. The `@cloudflare/vite-plugin`
 * emits this as a `CompiledWasm` module alongside the JS bundle.
 *
 * This is isolated in its own file so tests can easily mock it without needing
 * to handle raw `.wasm` imports in the Node test environment.
 */

// @ts-expect-error -- WASM module import resolved to WebAssembly.Module by Cloudflare at deploy time
export { default } from '../../../../vendor/biome_wasm_bg.wasm';
