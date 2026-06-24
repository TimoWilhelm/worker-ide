import { WorkflowEntrypoint } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';

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
import { getValidAccessToken } from '../lib/cloudflare-oauth';
import { filesystemNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
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
	/**
	 * Resolve a valid Cloudflare access token for the deploying user, refreshing
	 * it if needed. Fetched fresh inside each Cloudflare API step so long-running
	 * or retried deploys never use an expired token. The token is never stored in
	 * workflow step output.
	 */
	private async resolveAccessToken(userId: string): Promise<string> {
		const accessToken = await getValidAccessToken(
			{
				DB: this.env.DB,
				BETTER_AUTH_SECRET: this.env.BETTER_AUTH_SECRET,
				CLOUDFLARE_OAUTH_CLIENT_ID: this.env.CLOUDFLARE_OAUTH_CLIENT_ID,
				CLOUDFLARE_OAUTH_CLIENT_SECRET: this.env.CLOUDFLARE_OAUTH_CLIENT_SECRET,
			},
			userId,
		);
		if (!accessToken) {
			throw new NonRetryableError('Cloudflare account is not connected. Please reconnect and try again.');
		}
		return accessToken;
	}

	async run(event: WorkflowEvent<DeployWorkflowParameters>, step: WorkflowStep): Promise<DeployResult> {
		const parameters = event.payload;
		const filesystemId = toDurableObjectId(filesystemNamespace, parameters.projectId);
		const filesystemStub = filesystemNamespace.get(filesystemId);

		try {
			const inputs = await step.do('read-project-config', async () =>
				runWithProjectStub(filesystemStub, async () => readProjectBuildInputs(parameters.projectRoot), parameters.projectRoot),
			);

			const workerBundle = await step.do('bundle-worker', BUILD_STEP_CONFIG, async () =>
				runWithProjectStub(
					filesystemStub,
					async () => {
						try {
							return await bundleWorker(parameters.projectRoot, inputs);
						} catch (error) {
							throw toNonRetryableError(error);
						}
					},
					parameters.projectRoot,
				),
			);

			const frontendBundle = await step.do('bundle-frontend', BUILD_STEP_CONFIG, async () =>
				runWithProjectStub(filesystemStub, async () => bundleFrontend(parameters.projectRoot, inputs), parameters.projectRoot),
			);

			const staticAssets = entriesToStaticAssets(frontendBundle.staticAssetsEntries);
			let assetsCompletionJwt: string | undefined;
			if (staticAssets.size > 0) {
				assetsCompletionJwt = await step.do('upload-assets', CLOUDFLARE_API_STEP_CONFIG, async () => {
					const accessToken = await this.resolveAccessToken(parameters.userId);
					return uploadStaticAssets(parameters.accountId, accessToken, parameters.workerName, staticAssets);
				});
			}

			let r2BucketName: string | undefined;
			if (inputs.bindingsConfig.storage) {
				const bucketName = sanitizeR2BucketName(parameters.workerName);
				r2BucketName = bucketName;
				await step.do('ensure-r2-bucket', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
					const accessToken = await this.resolveAccessToken(parameters.userId);
					return ensureR2Bucket(parameters.accountId, accessToken, bucketName);
				});
			}

			await step.do('upload-worker-script', CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters.userId);
				return uploadWorkerScript(
					parameters.accountId,
					accessToken,
					parameters.workerName,
					workerBundle.workerCode,
					assetsCompletionJwt,
					inputs.assetSettings,
					r2BucketName,
				);
			});

			await step.do('enable-subdomain', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters.userId);
				return enableWorkersDevelopmentSubdomain(parameters.accountId, accessToken, parameters.workerName);
			});

			const workerUrl = await step.do('get-worker-url', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
				const accessToken = await this.resolveAccessToken(parameters.userId);
				return getWorkersDevelopmentUrl(parameters.accountId, accessToken, parameters.workerName);
			});

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
