import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { mount, withMounts } from 'worker-fs-mount';

import { sanitizeR2BucketName } from '@shared/deploy-helpers';

import {
	bundleFrontend,
	bundleWorker,
	enableWorkersDevelopmentSubdomain,
	ensureR2Bucket,
	entriesToStaticAssets,
	getWorkersDevelopmentUrl,
	readProjectBuildInputs,
	uploadStaticAssets,
	uploadWorkerScript,
} from './deploy-helpers';
import { trackProjectEvent } from '../lib/analytics';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { toDurableObjectId } from '../lib/project-id';

import type { DeployResult, DeployWorkflowParameters } from '@shared/deploy-types';
import type { WorkflowEvent, WorkflowStep, WorkflowStepConfig } from 'cloudflare:workers';

const BUILD_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};

const CLOUDFLARE_API_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 3, delay: '10 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
};

const SHORT_CLOUDFLARE_API_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 3, delay: '5 seconds', backoff: 'exponential' },
	timeout: '5 minutes',
};

function toNonRetryableError(error: unknown): Error {
	const message = error instanceof Error ? error.message : String(error);
	return new NonRetryableError(message);
}

export class DeployWorkflow extends WorkflowEntrypoint<Env, DeployWorkflowParameters> {
	async run(event: WorkflowEvent<DeployWorkflowParameters>, step: WorkflowStep): Promise<DeployResult> {
		const parameters = event.payload;
		const filesystemId = toDurableObjectId(filesystemNamespace, parameters.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);

		try {
			const inputs = await step.do('read-project-config', async () =>
				withMounts(async () => {
					mount(parameters.projectRoot, filesystemStub);
					return readProjectBuildInputs(parameters.projectRoot);
				}),
			);

			const workerBundle = await step.do('bundle-worker', BUILD_STEP_CONFIG, async () =>
				withMounts(async () => {
					mount(parameters.projectRoot, filesystemStub);
					try {
						return await bundleWorker(parameters.projectRoot, inputs);
					} catch (error) {
						throw toNonRetryableError(error);
					}
				}),
			);

			const frontendBundle = await step.do('bundle-frontend', BUILD_STEP_CONFIG, async () =>
				withMounts(async () => {
					mount(parameters.projectRoot, filesystemStub);
					return bundleFrontend(parameters.projectRoot, inputs);
				}),
			);

			const staticAssets = entriesToStaticAssets(frontendBundle.staticAssetsEntries);
			let assetsCompletionJwt: string | undefined;
			if (staticAssets.size > 0) {
				assetsCompletionJwt = await step.do('upload-assets', CLOUDFLARE_API_STEP_CONFIG, async () =>
					uploadStaticAssets(parameters.accountId, parameters.apiToken, parameters.workerName, staticAssets),
				);
			}

			let r2BucketName: string | undefined;
			if (inputs.bindingsConfig.storage) {
				const bucketName = sanitizeR2BucketName(parameters.workerName);
				r2BucketName = bucketName;
				await step.do('ensure-r2-bucket', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () =>
					ensureR2Bucket(parameters.accountId, parameters.apiToken, bucketName),
				);
			}

			await step.do('upload-worker-script', CLOUDFLARE_API_STEP_CONFIG, async () =>
				uploadWorkerScript(
					parameters.accountId,
					parameters.apiToken,
					parameters.workerName,
					workerBundle.workerCode,
					assetsCompletionJwt,
					inputs.assetSettings,
					r2BucketName,
				),
			);

			await step.do('enable-subdomain', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () =>
				enableWorkersDevelopmentSubdomain(parameters.accountId, parameters.apiToken, parameters.workerName),
			);

			const workerUrl = await step.do('get-worker-url', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () =>
				getWorkersDevelopmentUrl(parameters.accountId, parameters.apiToken, parameters.workerName),
			);

			const dashboardUrl = `https://dash.cloudflare.com/${parameters.accountId}/workers/services/view/${parameters.workerName}`;
			const result: DeployResult = { success: true, workerName: parameters.workerName, workerUrl, dashboardUrl };

			trackProjectEvent({
				organizationId: parameters.organizationId,
				eventType: 'deploy',
				projectId: parameters.projectId,
				userId: parameters.userId,
				detail: parameters.workerName,
				durationMs: Date.now() - parameters.requestStartedAt,
				success: true,
			});

			return result;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			trackProjectEvent({
				organizationId: parameters.organizationId,
				eventType: 'deploy',
				projectId: parameters.projectId,
				userId: parameters.userId,
				error: message,
				durationMs: Date.now() - parameters.requestStartedAt,
				success: false,
			});
			return { success: false, workerName: parameters.workerName, error: message };
		}
	}
}
