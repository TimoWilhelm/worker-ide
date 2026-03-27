import { getRepoStub, createLogger } from '@git/common/index';

import type { HeadInfo, Reference } from '../types';

export async function getHeadAndRefs(
	environment: GitWorkerEnvironment,
	repoId: string,
): Promise<{ head: HeadInfo | undefined; refs: Reference[] }> {
	const stub = getRepoStub(environment, repoId);
	const logger = createLogger(environment.LOG_LEVEL, { service: 'getHeadAndRefs', repoId });
	try {
		return await stub.getHeadAndRefs();
	} catch (error) {
		logger.debug('getHeadAndRefs:error', { error: String(error) });
		return { head: undefined, refs: [] };
	}
}
