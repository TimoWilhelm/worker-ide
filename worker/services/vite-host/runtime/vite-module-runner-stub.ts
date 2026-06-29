/**
 * Stub for `vite/module-runner`.
 *
 * vinext imports `ModuleRunner`/`ESModulesEvaluator`/`createNodeImportMeta`
 * from `vite/module-runner` for its dev server's server-side module execution.
 * The Vite Surface Host supplies its own LOADER-backed module runner, so these
 * classes only need to exist for the import to resolve; they are not used by
 * the host. Instantiating one signals a code path we have not wired up.
 */
export class ModuleRunner {
	constructor() {
		throw new Error('vite/module-runner ModuleRunner is not used by the Vite Surface Host');
	}
}

export class ESModulesEvaluator {}

export function createNodeImportMeta(): Record<string, unknown> {
	return {};
}

export default { ModuleRunner, ESModulesEvaluator, createNodeImportMeta };
