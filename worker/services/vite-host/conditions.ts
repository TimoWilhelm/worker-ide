/**
 * Per-environment package export conditions.
 *
 * Drive `package.json` `exports` resolution so each Vite environment bundles the
 * correct build of React and the RSC runtime:
 *  - `rsc`    → the React Server build (`react-server` condition)
 *  - `ssr`    → the server build (no `react-server`), workerd/edge runtime
 *  - `client` → the browser build
 */
import type { ViteEnvironmentName } from './types';

const CONDITIONS: Record<ViteEnvironmentName, readonly string[]> = {
	rsc: ['react-server', 'workerd', 'edge-light', 'import', 'module', 'browser', 'default'],
	ssr: ['workerd', 'edge-light', 'import', 'module', 'browser', 'default'],
	client: ['browser', 'import', 'module', 'default'],
};

/** Export conditions used to resolve npm packages for an environment. */
export function conditionsForEnvironment(environment: ViteEnvironmentName): readonly string[] {
	return CONDITIONS[environment];
}
