/**
 * No-op stand-in for `@vitejs/plugin-react`, aliased into the vendored
 * `native-plugins.mjs` bundle (see `scripts/vendor-vite-host.ts`).
 *
 * vinext pulls in `@vitejs/plugin-react` for two things, both of which the Vite
 * Surface Host already provides without Babel:
 *
 *  - **JSX**: the host transpiles `.jsx`/`.tsx` with esbuild (`jsx: 'automatic'`)
 *    in both the build bridge and the dev module server.
 *  - **React Fast Refresh**: the preview's dev module server injects the
 *    `$RefreshReg$`/`$RefreshSig$` registrations itself (`wrapForHmr`).
 *
 * `@vitejs/plugin-react` is a thin wrapper over Babel, and evaluating Babel
 * costs ~40 MB of heap on import — a third of the 128 MB build isolate, spent
 * before a single module is bundled. Since its transform is redundant here,
 * stubbing it to an empty plugin set removes Babel from the bundle entirely,
 * keeping both preview and deploy builds well within budget.
 */
import type { PluginOption } from '../types';

/** Matches `@vitejs/plugin-react`'s default export shape: a plugin factory. */
export default function reactPluginStub(): PluginOption[] {
	return [];
}
