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
	uploadWorkerModules,
	uploadWorkerScript,
	type ProjectBuildInputs,
} from './deploy-helpers';
import { trackProjectEvent } from '../lib/analytics';
import { getValidAccessToken } from '../lib/cloudflare-oauth';
import { filesystemNamespace, vinextPreviewHostNamespace } from '../lib/durable-object-namespaces';
import { runWithProjectStub } from '../lib/project-fs';
import { toDurableObjectId } from '../lib/project-id';
import { isVinextProject } from '../services/vite-host/vinext-detection';

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

// The vinext build + asset/script uploads run together in one step (so the
// large bundle is never persisted as step state); allow ample time for both.
const VINEXT_DEPLOY_STEP_CONFIG: WorkflowStepConfig = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'exponential' },
	timeout: '10 minutes',
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

			await (isVinextProject(inputs.allFiles)
				? this.bundleAndUploadVinext(step, parameters, inputs)
				: this.bundleAndUploadLegacy(step, parameters, filesystemStub, inputs));

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

	/**
	 * Standard project deploy: bundle the worker entry + frontend, upload static
	 * assets, ensure the R2 bucket, then upload the single-module worker script.
	 */
	private async bundleAndUploadLegacy(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		filesystemStub: ReturnType<typeof filesystemNamespace.get>,
		inputs: ProjectBuildInputs,
	): Promise<void> {
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

		const r2BucketName = await this.ensureProjectR2Bucket(step, parameters, inputs);

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
	}

	/**
	 * vinext project deploy: build the production server module set + client
	 * assets in the project's build Durable Object, then upload the client output
	 * as static assets and the server module set as a multi-module worker. The
	 * build + uploads happen inside a single step so the multi-megabyte bundle is
	 * never persisted as workflow step state (only the project source crosses step
	 * boundaries).
	 */
	private async bundleAndUploadVinext(step: WorkflowStep, parameters: DeployWorkflowParameters, inputs: ProjectBuildInputs): Promise<void> {
		const r2BucketName = await this.ensureProjectR2Bucket(step, parameters, inputs);

		await step.do('build-and-deploy-vinext', VINEXT_DEPLOY_STEP_CONFIG, async () => {
			const buildHost = vinextPreviewHostNamespace.getByName(`vinext:${parameters.projectId}`);
			let build;
			try {
				build = await buildHost.buildForDeploy(parameters.projectId, parameters.projectRoot);
			} catch (error) {
				throw toNonRetryableError(error);
			}

			const accessToken = await this.resolveAccessToken(parameters.userId);
			const staticAssets = new Map<string, Uint8Array>(
				Object.entries(build.clientOutput).map(([path, contents]) => [`/${path}`, new TextEncoder().encode(contents)]),
			);
			const assetsCompletionJwt =
				staticAssets.size > 0
					? await uploadStaticAssets(parameters.accountId, accessToken, parameters.workerName, staticAssets)
					: undefined;

			await uploadWorkerModules({
				accountId: parameters.accountId,
				accessToken,
				workerName: parameters.workerName,
				mainModule: build.mainModule,
				modules: Object.entries(build.serverModules).map(([name, contents]) => ({ name, contents })),
				assetsCompletionJwt,
				assetSettings: inputs.assetSettings,
				r2BucketName,
			});
		});
	}

	/** Ensure the project's R2 bucket exists when storage is enabled. */
	private async ensureProjectR2Bucket(
		step: WorkflowStep,
		parameters: DeployWorkflowParameters,
		inputs: ProjectBuildInputs,
	): Promise<string | undefined> {
		if (!inputs.bindingsConfig.storage) {
			return undefined;
		}
		const bucketName = sanitizeR2BucketName(parameters.workerName);
		await step.do('ensure-r2-bucket', SHORT_CLOUDFLARE_API_STEP_CONFIG, async () => {
			const accessToken = await this.resolveAccessToken(parameters.userId);
			return ensureR2Bucket(parameters.accountId, accessToken, bucketName);
		});
		return bucketName;
	}
}
