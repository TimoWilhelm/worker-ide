/**
 * Production build of a vinext app for deployment to a standalone Worker.
 *
 * Unlike the preview build, this runs WITHOUT host-development mode, so the
 * output is fully self-contained: the client bundle uses hashed chunks with
 * React and all client references bundled in (no `/@vinext-client/...` dev URLs,
 * no React-on-globals), and the server module set bundles React + the RSC
 * runtime. The only runtime requirement is the `nodejs_compat` flag (the server
 * entry uses `node:module`'s `createRequire`); no `node:fs` is needed at run
 * time. The result is ready to upload as a multi-module Worker script (server)
 * plus static assets (client).
 */
import { SERVER_RUNTIME_EXTERNALS } from './server-externals';
import { ViteHost } from '../vite-host';

/** vinext's App Router worker entry, the server module set's main module. */
const APP_ROUTER_ENTRY = '/__vinext__/dist/server/app-router-entry.js';

/** The built server entry's module name within the output set. */
const SERVER_MAIN_MODULE = 'index.js';

export interface VinextDeployBuild {
	/** Main module name within {@link serverModules} (the Worker's entry). */
	mainModule: string;
	/** Server (RSC + SSR) module set: `moduleName -> source`. */
	serverModules: Record<string, string>;
	/** Client output: `assetPath -> contents`, served as static assets. */
	clientOutput: Record<string, string>;
}

/**
 * Build a vinext project snapshot for deployment. `snapshot` is the project tree
 * keyed by absolute path (e.g. `/app/page.tsx`).
 */
export async function buildVinextForDeploy(snapshot: Record<string, string>): Promise<VinextDeployBuild> {
	const host = await ViteHost.create({
		files: snapshot,
		root: '/',
		command: 'build',
		mode: 'production',
		createPlugins: async () => {
			const { vinext } = await import('../../../../auxiliary/vite-host/vendor/native-plugins.mjs');
			return vinext();
		},
	});
	await host.build([...SERVER_RUNTIME_EXTERNALS], APP_ROUTER_ENTRY);

	return {
		mainModule: SERVER_MAIN_MODULE,
		serverModules: host.readOutput('/dist/server'),
		clientOutput: host.readOutput('/dist/client'),
	};
}
